// Supabase Edge Function: strava-sync
//
// Pulls the athlete's Strava activities and stores them as PENDING rows
// in strava_activities. The client then shows a review panel letting
// the user approve or decline each activity individually before it
// lands in exercise_logs. No auto-upsert.
//
// Uses PostgREST + auth REST API directly (the supabase-js ESM bundle
// fails to boot in the edge runtime).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STRAVA_ID = Deno.env.get("STRAVA_CLIENT_ID") || "";
const STRAVA_SECRET = Deno.env.get("STRAVA_CLIENT_SECRET") || "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });

// --- Strava type mapping ---
const TYPE_MAP: Record<string, string> = {
  Run: "Run", TrailRun: "Run", VirtualRun: "Run",
  Ride: "Cycling", VirtualRide: "Cycling",
  MountainBikeRide: "Cycling", GravelRide: "Cycling",
  EBikeRide: "Cycling", EMountainBikeRide: "Cycling",
  Handcycle: "Cycling", Velomobile: "Cycling",
  Walk: "Walk", Hike: "Walk",
  Swim: "Swim",
  Workout: "Other",
  WeightTraining: "Strength",
  Crossfit: "HIIT",
  HighIntensityIntervalTraining: "HIIT",
  Yoga: "Mobility", Pilates: "Mobility",
};
const METS: Record<string, number> = {
  Run: 9.8, Cycling: 7.5, Walk: 3.8, Strength: 5.0,
  Calisthenics: 6.0, HIIT: 8.0, Mobility: 2.5, Swim: 8.0, Other: 5.0,
};
const RUN_SUBTYPE: Record<number, string> = { 1: "Speed", 2: "Long", 3: "Speed" };

// --- REST helpers ---
async function verifyUser(jwt: string): Promise<string | null> {
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${jwt}`, apikey: SB_SERVICE },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}
async function pgGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` },
  });
  if (!r.ok) throw new Error(`pgGet ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function pgPatch(path: string, body: unknown) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: SB_SERVICE,
      Authorization: `Bearer ${SB_SERVICE}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`pgPatch ${path}: ${r.status} ${await r.text()}`);
}
async function pgUpsert(table: string, rows: unknown[], onConflict: string) {
  if (!rows.length) return;
  const r = await fetch(
    `${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`,
    {
      method: "POST",
      headers: {
        apikey: SB_SERVICE,
        Authorization: `Bearer ${SB_SERVICE}`,
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!r.ok) throw new Error(`pgUpsert ${table}: ${r.status} ${await r.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "missing auth" }, 401);
    const uid = await verifyUser(jwt);
    if (!uid) return json({ error: "invalid jwt" }, 401);

    const body = await req.json().catch(() => ({}));
    const fullResync: boolean = !!body.full;
    const weightKg: number = +body.weightKg || 75;

    // Load connection
    const conns = await pgGet(
      `strava_connections?user_id=eq.${uid}&select=*`,
    ) as Array<Record<string, unknown>>;
    const conn = conns[0];
    if (!conn) return json({ error: "not connected" }, 400);

    // Refresh access token if expired
    let accessToken = conn.access_token as string;
    const exp = new Date(conn.expires_at as string).getTime();
    if (Date.now() + 60_000 >= exp) {
      const rform = new URLSearchParams();
      rform.append("client_id", STRAVA_ID);
      rform.append("client_secret", STRAVA_SECRET);
      rform.append("grant_type", "refresh_token");
      rform.append("refresh_token", conn.refresh_token as string);
      const rres = await fetch("https://www.strava.com/api/v3/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: rform.toString(),
      });
      if (!rres.ok) return json({ error: "refresh failed", detail: await rres.text() }, 502);
      const t = await rres.json();
      accessToken = t.access_token;
      await pgPatch(`strava_connections?user_id=eq.${uid}`, {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(t.expires_at * 1000).toISOString(),
      });
    }

    // Decide time window
    const nowSec = Math.floor(Date.now() / 1000);
    const defaultLookback = 180 * 86400;
    const afterSec = fullResync
      ? nowSec - 365 * 86400
      : (conn.last_sync_at
          ? Math.max(0, Math.floor(new Date(conn.last_sync_at as string).getTime() / 1000) - 3600)
          : nowSec - defaultLookback);

    // Fetch list pages
    const listed: Array<Record<string, unknown>> = [];
    let page = 1;
    while (true) {
      const lres = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${afterSec}&per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (lres.status === 429) return json({ error: "strava rate limited" }, 429);
      if (!lres.ok) return json({ error: "list fetch", detail: await lres.text() }, 502);
      const batch = await lres.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      listed.push(...batch);
      if (batch.length < 100) break;
      page += 1;
      if (page > 10) break;
    }

    // Skip activities already in strava_activities (any status)
    let skipIds = new Set<number>();
    if (listed.length) {
      const ids = listed.map((a) => a.id as number).join(",");
      const existing = await pgGet(
        `strava_activities?user_id=eq.${uid}&activity_id=in.(${ids})&select=activity_id,status`,
      ) as Array<{ activity_id: number; status: string }>;
      if (!fullResync) {
        skipIds = new Set(existing.map((e) => e.activity_id));
      }
    }

    const DETAIL_BUDGET = 80;
    let detailsFetched = 0;
    let rateLimited = false;
    const toInsert: Array<Record<string, unknown>> = [];

    for (const a of listed) {
      if (skipIds.has(a.id as number)) continue;
      let detailed: Record<string, unknown> | null = null;
      if (!rateLimited && detailsFetched < DETAIL_BUDGET) {
        const dres = await fetch(
          `https://www.strava.com/api/v3/activities/${a.id}?include_all_efforts=true`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (dres.status === 429) rateLimited = true;
        else if (dres.ok) {
          detailed = await dres.json();
          detailsFetched += 1;
        }
      }
      const src = detailed ?? a;
      const stravaType = (src.sport_type || src.type || "Workout") as string;
      const mapped = TYPE_MAP[stravaType] ?? "Other";
      const durationMin = Math.round(((src.moving_time as number) || 0) / 60);
      const distanceKm = ((src.distance as number) || 0) / 1000;

      let kcal: number | null = null;
      if (typeof src.calories === "number") kcal = Math.round(src.calories);
      else if (typeof src.kilojoules === "number") kcal = Math.round((src.kilojoules as number) * 0.239);
      else if (durationMin > 0) kcal = Math.round((METS[mapped] || 5.0) * weightKg * (durationMin / 60));

      const avgSpeed = (src.average_speed as number) || null;
      const paceSecPerKm = avgSpeed && distanceKm > 0 ? Math.round(1000 / avgSpeed) : null;

      const details: Record<string, unknown> = {
        source: "strava",
        strava_id: src.id,
        strava_type: stravaType,
        mapped_type: mapped,
        has_details: !!detailed,
        name: src.name,
        description: src.description || null,
        start_date: src.start_date,
        start_date_local: src.start_date_local,
        timezone: src.timezone || null,
        duration_min: durationMin || null,
        distance_km: distanceKm || null,
        kcal,
        elapsed_time_s: src.elapsed_time || null,
        moving_time_s: src.moving_time || null,
        distance_m: src.distance || null,
        elevation_gain_m: src.total_elevation_gain || null,
        elev_high: src.elev_high || null,
        elev_low: src.elev_low || null,
        trainer: !!src.trainer,
        commute: !!src.commute,
        manual: !!src.manual,
        workout_type: src.workout_type ?? null,
        average_speed_mps: avgSpeed,
        max_speed_mps: src.max_speed || null,
        pace_sec_per_km: paceSecPerKm,
        has_heartrate: !!src.has_heartrate,
        average_heartrate: src.average_heartrate ?? null,
        max_heartrate: src.max_heartrate ?? null,
        suffer_score: src.suffer_score ?? null,
        average_cadence: src.average_cadence ?? null,
        average_watts: src.average_watts ?? null,
        weighted_average_watts: src.weighted_average_watts ?? null,
        max_watts: src.max_watts ?? null,
        device_watts: !!src.device_watts,
        kilojoules: src.kilojoules ?? null,
        gear_id: src.gear_id || null,
        map_polyline: (src.map as any)?.summary_polyline || null,
        photos_count: src.total_photo_count ?? 0,
      };
      if (mapped === "Run" && RUN_SUBTYPE[src.workout_type as number]) {
        details.runType = RUN_SUBTYPE[src.workout_type as number];
      }
      if (detailed) {
        if (Array.isArray(detailed.splits_metric)) {
          details.splits_km = (detailed.splits_metric as any[]).map((s) => ({
            km: s.split,
            seconds: s.moving_time,
            pace_sec_per_km: s.moving_time && s.distance
              ? Math.round(s.moving_time / (s.distance / 1000))
              : null,
            avg_hr: s.average_heartrate ?? null,
            elev_diff: s.elevation_difference ?? null,
          }));
        }
        if (Array.isArray(detailed.laps)) {
          details.laps = (detailed.laps as any[]).map((l) => ({
            name: l.name,
            moving_time: l.moving_time,
            distance_m: l.distance,
            avg_speed_mps: l.average_speed,
            avg_hr: l.average_heartrate ?? null,
            avg_cadence: l.average_cadence ?? null,
            avg_watts: l.average_watts ?? null,
          }));
        }
        if (Array.isArray(detailed.best_efforts)) {
          details.best_efforts = (detailed.best_efforts as any[]).map((b) => ({
            name: b.name, distance_m: b.distance, moving_time: b.moving_time, pr_rank: b.pr_rank ?? null,
          }));
        }

        // HR zones: separate endpoint. Fetch once per activity, attach to details.
        // Cheap (1 extra request per detail-fetched activity, within budget).
        if (!rateLimited && src.has_heartrate) {
          const zres = await fetch(
            `https://www.strava.com/api/v3/activities/${a.id}/zones`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (zres.status === 429) rateLimited = true;
          else if (zres.ok) {
            const zj = await zres.json();
            const hr = Array.isArray(zj) ? zj.find((z: any) => z.type === 'heartrate') : null;
            if (hr && Array.isArray(hr.distribution_buckets)) {
              details.hr_zones = hr.distribution_buckets.map((b: any) => ({
                min: b.min, max: b.max, time_s: b.time,
              }));
            }
          }
        }
      }

      toInsert.push({
        user_id: uid,
        activity_id: src.id,
        status: "pending",
        type: mapped,
        data: details,
      });
    }

    // Chunked insert with ignore-duplicates resolution (won't overwrite existing)
    const CHUNK = 50;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      await pgUpsert("strava_activities", toInsert.slice(i, i + CHUNK), "user_id,activity_id");
    }

    await pgPatch(`strava_connections?user_id=eq.${uid}`, {
      last_sync_at: new Date().toISOString(),
    });

    return json({
      ok: true,
      listed: listed.length,
      newly_pending: toInsert.length,
      details_fetched: detailsFetched,
      rate_limited: rateLimited,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
