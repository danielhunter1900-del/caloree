// Supabase Edge Function: strava-exchange
//
// Called once after the user returns from Strava's OAuth consent screen
// with a `code` query param. Exchanges the code for an access + refresh
// token and stores the connection in `strava_connections`.
//
// Required secrets (set via `supabase secrets set ...`):
//   STRAVA_CLIENT_ID
//   STRAVA_CLIENT_SECRET

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
    const code: string | undefined = body.code;
    if (!code) return json({ error: "missing code" }, 400);

    const form = new URLSearchParams();
    form.append("client_id", Deno.env.get("STRAVA_CLIENT_ID")!);
    form.append("client_secret", Deno.env.get("STRAVA_CLIENT_SECRET")!);
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
    // t = { access_token, refresh_token, expires_at (unix seconds), athlete: {...}, scope (optional) }

    const row = {
      user_id: uid,
      athlete_id: t.athlete?.id,
      athlete_firstname: t.athlete?.firstname ?? null,
      athlete_lastname: t.athlete?.lastname ?? null,
      athlete_username: t.athlete?.username ?? null,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: new Date(t.expires_at * 1000).toISOString(),
      scope: body.scope ?? null,
    };

    const { error: upErr } = await supa
      .from("strava_connections")
      .upsert(row, { onConflict: "user_id" });
    if (upErr) return json({ error: upErr.message }, 500);

    return json({
      ok: true,
      athlete: {
        id: row.athlete_id,
        firstname: row.athlete_firstname,
        lastname: row.athlete_lastname,
        username: row.athlete_username,
      },
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
