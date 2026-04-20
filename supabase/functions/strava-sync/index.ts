// Supabase Edge Function: strava-sync
//
// Pulls the athlete's activities from Strava and upserts them into
// `exercise_logs`. Each exercise row gets a deterministic id of
// `strava_<activityId>` so re-syncs don't duplicate and the client
// can tell Strava-sourced rows apart from manual/AI ones.
//
// Rich data (HR, splits, laps, best efforts, cadence, power) comes
// from the detailed `/activities/{id}` endpoint, called once per
// activity and cached in `details` JSONB. We refresh details for
// activities we've already seen only when last_sync_at is stale,
// since Strava activities are effectively immutable.
//
// Rate limits: 100 read req/15min, 1000/day. We cap each invocation
// to ~80 detailed fetches to leave headroom and bail politely if
// Strava returns 429.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });

// Map Strava type/sport_type -> our exercise types.
// Strava's `sport_type` (newer) is more granular than `type` (legacy).
const TYPE_MAP: Record<string, string> = {
  Run: "Run",
  TrailRun: "Run",
  VirtualRun: "Run",
  Ride: "Cycling",
  VirtualRide: "Cycling",
  MountainBikeRide: "Cycling",
  GravelRide: "Cycling",
  EBikeRide: "Cycling",
  EMountainBikeRide: "Cycling",
  Walk: "Walk",
  Hike: "Walk",
  Swim: "Swim",
  Workout: "Other",
  WeightTraining: "Strength",
  Crossfit: "HIIT",
  HighIntensityIntervalTraining: "HIIT",
  Yoga: "Mobility",
  Pilates: "Mobility",
  Elliptical: "Other",
  StairStepper: "Other",
  Rowing: "Other",
  Kayaking: "Other",
  Canoeing: "Other",
  StandUpPaddling: "Other",
  Surfing: "Other",
  Kitesurf: "Other",
  Windsurf: "Other",
  Snowboard: "Other",
  AlpineSki: "Other",
  BackcountrySki: "Other",
  NordicSki: "Other",
  IceSkate: "Other",
  InlineSkate: "Other",
  RockClimbing: "Other",
  Golf: "Other",
  Handcycle: "Cycling",
  Velomobile: "Cycling",
  Wheelchair: "Other",
  Badminton: "Other",
  Tennis: "Other",
  TableTennis: "Other",
  Pickleball: "Other",
  Squash: "Other",
  Soccer: "Other",
};

// Rough METs for kcal fallback when Strava doesn't send calories/kilojoules.
const METS: Record<string, number> = {
  Run: 9.8, Cycling: 7.5, Walk: 3.8, Strength: 5.0,
  Calisthenics: 6.0, HIIT: 8.0, Mobility: 2.5, Swim: 8.0, Other: 5.0,
};

// workout_type (for runs): 0 default, 1 race, 2 long run, 3 workout
const RUN_SUBTYPE: Record<number, string> = { 1: "Speed", 2: "Long", 3: "Speed" };

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "missing auth" }, 401);

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
    if (userErr || !userData.user) return json({ error: "invalid jwt" }, 401);
    const uid = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const fullResync: boolean = !!body.full;
    const weightKg: number = +body.weightKg || 75;

    const { data: conn, error: connErr } = await supa
      .from("strava_connections")
      .select("*")
      .eq("user_id", uid)
      .maybeSingle();
    if (connErr) return json({ error: connErr.message }, 500);
    if (!conn) return json({ error: "not connected" }, 400);

    // Refresh access token if expired (or within 60s of expiring).
    let accessToken = conn.access_token;
    const exp = new Date(conn.expires_at).getTime();
    if (Date.now() + 60_000 >= exp) {
      const rform = new URLSearchParams();
      rform.append("client_id", Deno.env.get("STRAVA_CLIENT_ID")!);
      rform.append("client_secret", Deno.env.get("STRAVA_CLIENT_SECRET")!);
      rform.append("grant_type", "refresh_token");
      rform.append("refresh_token", conn.refresh_token);
      const rres = await fetch("https://www.strava.com/api/v3/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: rform.toString(),
      });
      if (!rres.ok) return json({ error: "refresh failed", detail: await rres.text() }, 502);
      const t = await rres.json();
      accessToken = t.access_token;
      await supa.from("strava_connections").update({
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(t.expires_at * 1000).toISOString(),
      }).eq("user_id", uid);
    }

    // Decide time window.
    const nowSec = Math.floor(Date.now() / 1000);
    const defaultLookback = 180 * 86400; // 180 days on first sync
    const afterSec = fullResync
      ? nowSec - 365 * 86400 // 1 year when explicitly asked
      : (conn.last_sync_at
          ? Math.max(0, Math.floor(new Date(conn.last_sync_at).getTime() / 1000) - 3600)
          : nowSec - defaultLookback);

    // Fetch list pages until we exhaust.
    const listed: any[] = [];
    let page = 1;
    while (true) {
      const lres = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${afterSec}&per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (lres.status === 429) {
        return json({ error: "strava rate limited, try again later" }, 429);
      }
      if (!lres.ok) return json({ error: "list fetch failed", detail: await lres.text() }, 502);
      const batch = await lres.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      listed.push(...batch);
      if (batch.length < 100) break;
      page += 1;
      if (page > 10) break; // safety
    }

    // Which activities do we already have detailed? Skip re-fetching them
    // unless fullResync is true.
    const existingIds = new Set<string>();
    if (!fullResync && listed.length) {
      const ids = listed.map((a) => "strava_" + a.id);
      const { data: existing } = await supa
        .from("exercise_logs")
        .select("id, details")
        .eq("user_id", uid)
        .in("id", ids);
      (existing || []).forEach((r) => {
        if (r?.details?.has_details) existingIds.add(r.id);
      });
    }

    // Detailed fetch budget. 80 keeps us well under 100/15min.
    const DETAIL_BUDGET = 80;
    let detailsFetched = 0;
    let rateLimited = false;

    const rows: any[] = [];
    for (const a of listed) {
      const rowId = "strava_" + a.id;
      let detailed: any = null;
      if (!rateLimited && !existingIds.has(rowId) && detailsFetched < DETAIL_BUDGET) {
        const dres = await fetch(
          `https://www.strava.com/api/v3/activities/${a.id}?include_all_efforts=true`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (dres.status === 429) {
          rateLimited = true;
        } else if (dres.ok) {
          detailed = await dres.json();
          detailsFetched += 1;
        }
      }
      const src = detailed ?? a;

      const stravaType = src.sport_type || src.type || "Workout";
      const mapped = TYPE_MAP[stravaType] ?? "Other";
      const durationMin = Math.round((src.moving_time || 0) / 60);
      const distanceKm = (src.distance || 0) / 1000;

      // kcal: prefer Strava's own, then kilojoules (rides w/ power), else MET estimate.
      let kcal: number | null = null;
      if (typeof src.calories === "number") kcal = Math.round(src.calories);
      else if (typeof src.kilojoules === "number") kcal = Math.round(src.kilojoules * 0.239);
      else if (durationMin > 0) kcal = Math.round((METS[mapped] || 5.0) * weightKg * (durationMin / 60));

      // Pace / speed for foot + cycling activities.
      const avgSpeed = src.average_speed || null; // m/s
      const maxSpeed = src.max_speed || null;
      const paceSecPerKm = avgSpeed && distanceKm > 0
        ? Math.round(1000 / avgSpeed)
        : null;

      const details: Record<string, unknown> = {
        source: "strava",
        strava_id: src.id,
        strava_type: stravaType,
        has_details: !!detailed,
        name: src.name,
        description: src.description || null,
        start_date: src.start_date,
        start_date_local: src.start_date_local,
        timezone: src.timezone || null,
        elapsed_time_s: src.elapsed_time || null,
        moving_time_s: src.moving_time || null,
        distance_m: src.distance || null,
        elevation_gain_m: src.total_elevation_gain || null,
        elev_high: src.elev_high || null,
        elev_low: src.elev_low || null,
        trainer: !!src.trainer,
        commute: !!src.commute,
        manual: !!src.manual,
        private: !!src.private,
        workout_type: src.workout_type ?? null,
        average_speed_mps: avgSpeed,
        max_speed_mps: maxSpeed,
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
        map_polyline: src.map?.summary_polyline || null,
        photos_count: src.total_photo_count ?? 0,
      };

      // Run subtype from workout_type.
      if (mapped === "Run" && RUN_SUBTYPE[src.workout_type as number]) {
        details.runType = RUN_SUBTYPE[src.workout_type as number];
      }

      // Rich structures only present on detailed fetches.
      if (detailed) {
        if (Array.isArray(detailed.splits_metric)) {
          details.splits_km = detailed.splits_metric.map((s: any) => ({
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
          details.laps = detailed.laps.map((l: any) => ({
            name: l.name,
            moving_time: l.moving_time,
            distance_m: l.distance,
            avg_speed_mps: l.average_speed,
            max_speed_mps: l.max_speed,
            avg_hr: l.average_heartrate ?? null,
            max_hr: l.max_heartrate ?? null,
            avg_cadence: l.average_cadence ?? null,
            avg_watts: l.average_watts ?? null,
          }));
        }
        if (Array.isArray(detailed.best_efforts)) {
          details.best_efforts = detailed.best_efforts.map((b: any) => ({
            name: b.name,
            distance_m: b.distance,
            moving_time: b.moving_time,
            pr_rank: b.pr_rank ?? null,
          }));
        }
        if (Array.isArray(detailed.segment_efforts)) {
          // Too large to store all; keep a compact summary of the top 5.
          details.segments_sample = detailed.segment_efforts.slice(0, 5).map((s: any) => ({
            name: s.name,
            distance_m: s.distance,
            moving_time: s.moving_time,
            pr_rank: s.pr_rank ?? null,
            kom_rank: s.kom_rank ?? null,
          }));
        }
      }

      rows.push({
        id: rowId,
        user_id: uid,
        date: (src.start_date_local || src.start_date || new Date().toISOString()).slice(0, 10),
        type: mapped,
        duration_min: durationMin || null,
        distance_km: distanceKm || null,
        kcal,
        notes: [src.name, src.description].filter(Boolean).join(" — ") || null,
        details,
      });
    }

    let upserted = 0;
    if (rows.length) {
      // Upsert in chunks to avoid big requests.
      const CHUNK = 50;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { error: upErr } = await supa
          .from("exercise_logs")
          .upsert(slice, { onConflict: "id" });
        if (upErr) return json({ error: upErr.message, upsertedSoFar: upserted }, 500);
        upserted += slice.length;
      }
    }

    await supa.from("strava_connections").update({
      last_sync_at: new Date().toISOString(),
    }).eq("user_id", uid);

    return json({
      ok: true,
      listed: listed.length,
      upserted,
      details_fetched: detailsFetched,
      rate_limited: rateLimited,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
