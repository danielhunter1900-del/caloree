-- Strava OAuth tokens + per-user connection metadata.
-- Tokens are written by edge functions using the service role.
-- Clients only need to read a sanitized view (connected? who? last sync?).

create table if not exists strava_connections (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  athlete_id        bigint not null,
  athlete_firstname text,
  athlete_lastname  text,
  athlete_username  text,
  access_token      text   not null,
  refresh_token     text   not null,
  expires_at        timestamptz not null,
  scope             text,
  last_sync_at      timestamptz,
  created_at        timestamptz not null default now()
);

alter table strava_connections enable row level security;

-- Clients can only see their own row. Tokens are in this row, but:
--  • RLS restricts them to the owner (who already has them implicitly anyway).
--  • The client never needs to touch tokens; edge functions mediate all
--    Strava calls. We never expose tokens to other users.
drop policy if exists "own strava connection" on strava_connections;
create policy "own strava connection"
  on strava_connections for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- When a Strava-sourced exercise row is deleted by the client, the edge
-- function can re-create it on the next sync. If the user wants it gone
-- permanently, they should disconnect Strava (which wipes the connection
-- and leaves the rows as local-only).
