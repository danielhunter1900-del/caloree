# Caloree — Handoff Notes

Open a new Claude chat and say:

> Read https://raw.githubusercontent.com/danielhunter1900-del/caloree/main/HANDOFF.md for full project context. Then describe what I want to do next.

That's it — everything below is what the new Claude needs.

---

## Paths & infra
- **Local source:** `/Users/danielhunter/Library/Application Support/Anki2/addons21/236979321/calorie-app/`
- **Repo:** `https://github.com/danielhunter1900-del/caloree` (public)
- **Live:** `https://danielhunter1900-del.github.io/caloree/` — GitHub Pages, redeploys ~60s after push
- **Supabase project:** `twvmaazfcpglrzknhsvr` · URL `https://twvmaazfcpglrzknhsvr.supabase.co` · anon key hardcoded in index.html (`sb_publishable_4XMUfqp1Bl7SkrbMDYds4w_AVqq4e7d`)
- **Current version:** **v43** (Profile footer shows `CALOREE · v43`). Always bump `APP_VERSION` in index.html AND `CACHE` in sw.js together when making client changes. Git auto-deploys; PWA auto-updates via SW on next focus.

## Accounts
- **User email:** `danielhunter1998@gmail.com` (the real account with data) — user logs in themselves; Claude can't enter passwords.
- **Demo:** `demo@caloree.app` / `DEMO_PW_REDACTED` (for Chrome sessions).
- **Strava API app:** Client ID `227929`, Client Secret `STRAVA_CLIENT_SECRET_REDACTED_ROTATED`, callback domain `danielhunter1900-del.github.io`. Both stored as Supabase function secrets.
- **Supabase PAT used for DDL / function deploys:** `sbp_REDACTED_REVOKED_REVOKED` — may have been revoked; if it 401s, ask user for a new one at https://supabase.com/dashboard/account/tokens.
- **Anthropic API:** stored in browser localStorage (`anthropic_api_key`), user pastes via Profile. All AI calls are client-side with `anthropic-dangerous-direct-browser-access: true`.

## Supabase schema
- `profiles` (targets, settings, theme, target_history jsonb)
- `foods` (user_id, macros, ingredients jsonb, photo_path, is_favourite)
- `meal_logs` (id, user_id, date, meal, food_id, qty, time)
- `exercise_logs` (id, user_id, date, type, duration_min, distance_km, kcal, notes, details jsonb — incl. runType + Strava payload)
- `weight_logs` (user_id, iso, kg)
- `wellness_logs` (user_id, date, coffees, water, sleep_hrs, stress, energy, reading_min, **extras jsonb** — rehab bool, mobility {morning,lunch,afternoon})
- `strava_connections` (user_id PK, athlete_id, access_token, refresh_token, expires_at, last_sync_at)
- `strava_activities` (user_id, activity_id PK, status pending|approved|declined, type, data jsonb, exercise_log_id)
- All tables RLS-protected on `auth.uid() = user_id`.

## Edge functions (ACTIVE, `verify_jwt: false`)
- `strava-exchange` — OAuth code → tokens → upsert connection.
- `strava-sync` — refresh token, pull activities, detail-fetch up to 80/run, upsert into `strava_activities` as **pending** (never auto-writes `exercise_logs`).
- Both use raw `fetch` against REST (not supabase-js — that ESM bundle fails to boot in Supabase's Deno runtime). Both do manual JWT verification via `/auth/v1/user` because the gateway only knows HS256 and the project uses ES256.

## Architecture (index.html, ~11k lines, single file)
- React via unpkg CDN, Babel in-browser, no build step.
- Source of truth = Supabase. Hydration on login **always replaces local state with cloud, even if cloud is empty** (fixes cross-account bleed). localStorage is offline cache only.
- `window.sb` is the supabase-js client; writes are fire-and-forget. **Offline queue not yet built.**
- `window.HISTORY` = flat array of per-day macro+wellness rows, rebuilt from cloud on hydration. Trends reads from this.
- `window.EX_COLORS`, `EX_ICONS`, `EX_METS` — default exercise type maps. User-added custom types merged via `applyCustomExerciseTypes(settings.customExerciseTypes)`.
- `todayLocalIso()` helper — **always use instead of `new Date().toISOString().slice(0, 10)`**. The latter returns UTC; returns yesterday in timezones ahead of UTC (user is AEST). 20 call sites already migrated.
- Streak helpers: `STREAK_TIERS`, `streakTier(days)`, `streakShortLabel(days)`, `<StreakChip>` in Header.

## Key features shipped
- Onboarding wizard (name, sex, age, height, weight, activity, goal → Mifflin-St Jeor targets + first weight log). Returning users auto-marked onboarded if any prior data exists.
- Profile: "Your details" card, Strava card (above API key, More-options drawer), Anthropic key (collapsed by default), Export JSON/CSV, theme, sign out. Ask-Claude goals: goal picker + preview diff + Approve/Decline + Undo toast + "What Claude is looking at" expander.
- Home: calorie ring, macro drill (React.createPortal to body, tap-to-toggle multi-select, iOS swipe-friendly), Wellness card (reorderable rows, rehab toggle, mobility AM/Lunch/PM, reading min, coffee/water/sleep/stress/energy), Exercise card (with custom types + "+New"), meal sections (swipe-to-delete + drag-to-merge only in Edit mode), quick stats footer, Weight tile → jumps to Trends → scrolls into view.
- **Day lock** (`markedComplete` per date in localStorage): "Finish for today" or "Lock day" button works for any date. Locked day: Edit toggle hidden, all `+` buttons gone, Wellness fades + pointer-events off, DetailScreen disables Save/Move/Copy.
- Trends: Calories / Exercise tabs (secondary Min/Cal toggle under Exercise), stacked bar chart (filterable by type chip), Average-macros card reflects selected bar(s) (multi-select by tap, selSet is source of truth), Wellness strip (reorderable rows via "Reorder" chip), Exercise calendar (Month grid with dot overlay, Week row, Year month-tiles), Ask-Claude coach (full 14-day data + exercise + weight trend + wellness). Weight chart = SVG line with hover tooltip + >7-day stale indicator; "Clear weight history" button in card.
- AI Chat: meal selector defaults to the section you came from (Lunch → pending card starts on Lunch); "Suggest change" revise flow with inline feedback textarea; paste-JSON mode; AI-log undo toast removes entries + synthetic foods from DB.
- Strava: Connect → OAuth → auto-sync → pending activities → Review sheet with rich per-activity stats (HR, splits, laps, pace, cadence, power); custom exercise types; run subtypes (Easy/Long/Speed/Steady) stored in `details.runType`; ExerciseDetailSheet full-screen with intervals promoted for Speed runs; cadence doubled for runs.
- **Streak chip** in Home header: 9 tiers (3d→2yrs), flame gets hotter/bigger with inner core glow past day 60, tap toggles short label ↔ day count (`settings.streakLabelMode`), at-risk red flame after 9pm local. Local-date off-by-one fixed.
- Service worker auto-update: `updateViaCache: none` + `controllerchange → reload()` + revalidate on visibility.
- Favourites live-search in LogScreen; Recent = user's actual log (no hardcoded list).
- Label photos skipped from meal gallery (only full meal photos persist).
- Ingredient grams edit uses `defaultValue` + `onBlur` (so clearing to retype doesn't zero macros).

## Mockups on disk (`docs/mockups/`)
Numbered SVGs + rendered PNGs. Recent: `recipe-import`, `streak-tiers`, `streak-confetti`, `streak-header`, `recipes`, `macro-split`, `photo-gallery`, `strava-card-v2`, `icon-flat{,-ink,-terracotta}`, `10-heatmap-calendar-filter`, `7-9-heatmap-*`.

## Pending features (user-requested, not yet built)
1. **Offline queue** for Supabase writes + "unsynced" badge. Explicitly deferred by user.
2. **Streak freeze** (1/month auto-skip) + **Fresh-start day-1** override + **milestone confetti** (fires once at 7/30/100/365).
3. **Recipe library** (per `recipe-import.svg`) — import TikTok/URL/OCR → Claude parses → servings scale + metric/imperial toggle → save/log.
4. **Macro split visualization** under Home ring (per `macro-split.svg`).
5. **Photo journal tab** (per `photo-gallery.svg`).
6. **Apple Shortcut weight-ingest endpoint** — edge function accepting per-user opaque key + {kg, iso} → insert weight_logs. Lets user auto-sync HealthKit weight into Caloree.
7. **Google Fit** integration (pattern copies Strava exactly).

## Open design decisions
- User is keeping this as **personal PWA**, not commercial. Don't spend time on native wrap, App Store, or Stripe.
- User has Apple Watch → workouts flow via HealthFit ($4.99 iOS one-time app) → Strava → Caloree. No direct HealthKit API in the PWA.
- Flat-icon variants exist in mockups but `icon.svg` / `icon-192.png` / `icon-512.png` not yet swapped.

## Common operations

**Version bump + push:**
```bash
cd "/Users/danielhunter/Library/Application Support/Anki2/addons21/236979321/calorie-app"
# edit index.html -> const APP_VERSION = 'vN'
# edit sw.js     -> const CACHE = 'caloree-vN'
git add index.html sw.js && git commit -m "..." && git push
```

**Run SQL via Management API:**
```bash
curl -s -X POST 'https://api.supabase.com/v1/projects/twvmaazfcpglrzknhsvr/database/query' \
  -H 'Authorization: Bearer sbp_REDACTED_REVOKED_REVOKED' \
  -H 'Content-Type: application/json' \
  -d '{"query":"..."}'
```

**Deploy / update an edge function:**
```bash
BODY=$(cat supabase/functions/NAME/index.ts | python3 -c 'import sys, json; print(json.dumps(sys.stdin.read()))')
curl -s -X PATCH "https://api.supabase.com/v1/projects/twvmaazfcpglrzknhsvr/functions/NAME" \
  -H 'Authorization: Bearer sbp_REDACTED_REVOKED_REVOKED' \
  -H 'Content-Type: application/json' \
  -d "{\"body\":$BODY,\"verify_jwt\":false}"
```

**Render SVG mockups:**
```bash
qlmanage -t -s 900 -o . mockup.svg    # creates mockup.svg.png
```

## Gotchas
- **Supabase dashboard is blocked by the Claude-in-Chrome extension** ("Stop Claude" overlay on supabase.com). Use Management API + PAT for any schema/function work.
- **ES256 JWTs**: gateway `verify_jwt: true` fails. Set `false` and verify inside the function via `/auth/v1/user`.
- **Deno edge runtime** hates `@supabase/supabase-js` ESM import. Use raw `fetch` against `/auth/v1/user` and `/rest/v1/*` with the service role key.
- **iOS scroll trap**: any bottom-sheet modal must be portalled to `document.body` via `ReactDOM.createPortal` — being inside the app's inner `overflow: auto` container makes iOS treat `position: fixed` as absolute. Add a doc-level `touchmove` handler that preventDefaults everything not inside the panel *and* when the panel itself can't scroll.
- **iOS PWA update cycle** is slow. `updateViaCache: none` + `controllerchange → reload()` is already wired. If user reports "still on old version", tell them to kill the PWA from app switcher.
- **Timezone**: never `toISOString().slice(0,10)` for a date. Use `todayLocalIso()`.
- **Haptics** (`navigator.vibrate`) don't work on iOS Safari. Android only. Real haptics require a Capacitor wrap.

## Useful Chrome MCP snippets (to run in the app console)

```js
// Check sign-in + version
(async () => ({ email: (await window.sb.auth.getUser()).data?.user?.email, version: window.APP_VERSION }))()

// Force-update PWA from old SW
const regs = await navigator.serviceWorker.getRegistrations();
for (const r of regs) await r.unregister();
for (const k of await caches.keys()) await caches.delete(k);
location.reload();

// Wipe a user's weight history (cloud + local)
const uid = (await window.sb.auth.getUser()).data.user.id;
await window.sb.from('weight_logs').delete().eq('user_id', uid);
localStorage.removeItem('cal_weight');
location.reload();
```
