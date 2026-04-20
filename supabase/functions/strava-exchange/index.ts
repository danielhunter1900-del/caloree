// Supabase Edge Function: strava-exchange
//
// Uses the REST API directly (PostgREST + auth) so we don't need the
// @supabase/supabase-js package — its ESM bundle keeps failing to boot
// in the edge runtime environment.

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

async function verifyUser(jwt: string): Promise<string | null> {
  // Hit the auth /user endpoint with the user's JWT to get their id.
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      apikey: SB_SERVICE,
    },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}

async function upsertConnection(uid: string, row: Record<string, unknown>) {
  const r = await fetch(
    `${SB_URL}/rest/v1/strava_connections?on_conflict=user_id`,
    {
      method: "POST",
      headers: {
        apikey: SB_SERVICE,
        Authorization: `Bearer ${SB_SERVICE}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ user_id: uid, ...row }),
    },
  );
  if (!r.ok) throw new Error(`upsert failed: ${r.status} ${await r.text()}`);
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
    const code: string | undefined = body.code;
    if (!code) return json({ error: "missing code" }, 400);

    const form = new URLSearchParams();
    form.append("client_id", STRAVA_ID);
    form.append("client_secret", STRAVA_SECRET);
    form.append("code", code);
    form.append("grant_type", "authorization_code");

    const sres = await fetch("https://www.strava.com/api/v3/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!sres.ok) {
      const txt = await sres.text();
      return json({ error: "strava exchange failed", detail: txt }, 502);
    }
    const t = await sres.json();

    await upsertConnection(uid, {
      athlete_id: t.athlete?.id,
      athlete_firstname: t.athlete?.firstname ?? null,
      athlete_lastname: t.athlete?.lastname ?? null,
      athlete_username: t.athlete?.username ?? null,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: new Date(t.expires_at * 1000).toISOString(),
      scope: body.scope ?? null,
    });

    return json({
      ok: true,
      athlete: {
        id: t.athlete?.id,
        firstname: t.athlete?.firstname,
        lastname: t.athlete?.lastname,
        username: t.athlete?.username,
      },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
