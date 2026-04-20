# Caloree — Handoff Notes

A single-file React calorie/macro/wellness/exercise tracker with Claude AI integration, Supabase sync, and PWA support. Built for personal use, deployed to GitHub Pages.

---

## Files & Locations

**Working directory (local source):**
`/Users/danielhunter/Library/Application Support/Anki2/addons21/236979321/calorie-app/`

**Files in the project:**
- `index.html` — the entire app (React + Babel via CDN, ~12k lines, single file)
- `manifest.json` — PWA manifest
- `sw.js` — service worker (cache version is `caloree-v3`; bump on big changes)
- `icon.svg` / `icon-192.png` / `icon-512.png` / `apple-touch-icon.png` — PWA icons (peach-mint design)
- `README.md` — quick deploy notes
- `.gitignore` — excludes `.claude/`, `icon-previews/`

**Live deploy:** https://danielhunter1900-del.github.io/caloree/
**GitHub repo:** https://github.com/danielhunter1900-del/caloree (public)

---

## Credentials & Accounts

**User's GitHub username:** `danielhunter1900-del`
**User's email:** `danielhunter1900@gmail.com` (their real account)

**Demo account** (for showing partner / friends — NOT for daily use):
- Email: `demo@caloree.app`
- Password: `DEMO_PW_REDACTED`

**Supabase project:**
- Dashboard: https://supabase.com/dashboard/project/twvmaazfcpglrzknhsvr
- Project URL: `https://twvmaazfcpglrzknhsvr.supabase.co`
- Publishable (anon) key: `sb_publishable_4XMUfqp1Bl7SkrbMDYds4w_AVqq4e7d` (safe to expose; hardcoded in `index.html`)
- Free tier; pauses after 7 days of inactivity (data preserved, just dashboard click to restore)

**Anthropic API key:** stored only in user's browser localStorage (`anthropic_api_key`). Never in source. User pastes via Profile → "Anthropic API key" card. Code strips whitespace and rejects keys not starting with `sk-ant-`.

**GitHub deploy token:** Personal Access Token saved in local `.git/config` under remote URL. Expires May 19, 2026. After expiry, run `gh auth login` or generate a new PAT at https://github.com/settings/tokens.

---

## Pushing Updates

```sh
cd "/Users/danielhunter/Library/Application Support/Anki2/addons21/236979321/calorie-app"
git add -A
git commit -m "<message>"
git push
```

GitHub Pages auto-redeploys ~1 min after push. To force PWA refresh on the user's iPhone after a big change, bump `CACHE` in `sw.js`.

---

## Supabase Schema

All tables have RLS — every policy is `auth.uid() = user_id`. Storage bucket `meal-photos` is private with same per-user RLS.

```sql
-- profiles (one row per user)
profiles (
  user_id uuid PRIMARY KEY references auth.users,
  targets jsonb,           -- { kcal, c, p, f, satFat, sugar, fibre, exKcal, exMin }
  settings jsonb,          -- { adjustForExercise, ... }
  theme text,              -- 'clinical' | 'warm' | 'editorial'
  target_history jsonb,    -- [{ from_date: 'YYYY-MM-DD', targets: {...} }, ...]
  updated_at timestamptz
)

-- foods (synthetic + AI-generated; seeded library kept in JS for now)
foods (
  id text PRIMARY KEY,     -- 'ai_*' or 'demo_*' or merged 'ai_merge_*'
  user_id uuid,
  name text, brand text,
  serving_g numeric,
  kcal/c/p/f/sat_fat/sugar/fibre numeric,
  is_favourite boolean,
  photo_path text,         -- storage key
  ingredients jsonb,       -- [{ name, g, kcal, c, p, f, satFat, sugar, fibre }, ...]
  created_at timestamptz
)

meal_logs (
  id text PRIMARY KEY,     -- 'l_*'
  user_id uuid,
  date date,               -- ISO YYYY-MM-DD
  meal text,               -- 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack'
  food_id text references foods,
  qty numeric,
  time text,
  created_at timestamptz
)

exercise_logs (
  id text PRIMARY KEY,
  user_id uuid,
  date date,
  type text,               -- Run | Cycling | Walk | Strength | Calisthenics | HIIT | Mobility | Other
  duration_min numeric,
  distance_km numeric,
  kcal numeric,
  notes text,
  details jsonb,           -- { sets: [...], movements: [...] } for Strength/Calisthenics
  created_at timestamptz
)

weight_logs (
  id bigserial PRIMARY KEY,
  user_id uuid, iso date, kg numeric,
  UNIQUE (user_id, iso)
)

wellness_logs (
  user_id uuid, date date,
  coffees int, water int, sleep_hrs numeric, stress int, energy int,
  PRIMARY KEY (user_id, date)
)
```

**Auto-create profile trigger** on `auth.users` insert (fires `public.handle_new_user()` security-definer function with `set search_path = public`).

---

## App Architecture

Single-file React app via Babel runtime (no build step). Key concepts:

- **AppRoot** — auth gate (LoginScreen if no session, App if signed in)
- **App** — top-level state (log, foods, targets, settings, exerciseLog, weightLog, wellnessMap, themeKey, tab, logDate)
- **Cloud sync** — `useEffect([session])` pulls everything once on login; per-state push effects upsert on change
- **HISTORY** — module-level array that's mutated in place after cloud pull; Trends reads from it
- **FOODS** — module-level array; merged with cloud foods on pull; mutated by toggle-favourite, merge, modify-with-Claude
- **localStorage backup** for: `cal_log`, `cal_ai_foods`, `cal_targets`, `cal_target_history`, `cal_weight`, `cal_settings`, `cal_wellness_map`, `cal_exercise`, `cal_marked_complete`, `cal_favourite_ids`, `cal_display_name`, `cal_theme`, `cal_bulk_draft`, `cal_wellness_open`

### Tab structure
- **Home** (`tab === 'home'`) — date scrubber, calorie ring (toggleable Calories/Exercise), macro bars, status banner, wellness card, exercise card, meal sections
- **Trends** (`tab === 'progress'`) — bar chart with metric toggle (Calories eaten / Burned / Min active), exercise breakdown by type, average macros card, wellness signals strip chart, Ask Claude button
- **AI** (`tab === 'ai'`) — Chat with Claude OR Paste JSON; reachable via + → AI
- **Profile** (`tab === 'profile'`) — name, weight + trend + Ask Claude, daily goals editor (kcal/c/p/f/satFat/sugar/fibre/exMin + adjustForExercise toggle), photos gallery, theme picker, Anthropic API key, export (JSON/CSV), sign out

### Bottom tab bar
- Today (left)
- Centered + button (opens AddPickerSheet: Manual / AI / Notes / Paste from Claude / Log exercise)
- Trends (right)

### Key UX patterns
- **Drag handle** (thin grey vertical bar) on left of each meal row → tap+drag to **move** (drop on a meal section) or **merge** (drop on another row)
- **Long-press** on meal row also works as drag fallback
- **Edit chip** at top of meal area → checkbox select mode → Move/Copy bar → date picker
- **Swipe-left** on meal row → reveals red Delete button
- **Drill into macros** by tapping any macro bar or the calorie ring → contributor list
- **Wellness strip rows** clickable on left (fade) and right (drilldown)
- **Undo toasts** for delete (meal/exercise) and merge

---

## Claude API Integration

All Claude API calls use `claude-sonnet-4-6` with `anthropic-dangerous-direct-browser-access: true`. Key reads strip whitespace via `.replace(/\s+/g, '')`.

**Endpoints used (all client-side fetch):**
- AIChat (one-message log) — supports text + photo (Food / Label toggle)
- BulkNotesSheet — text + multiple photos with `photo_index` mapping each to its meal
- PasteFromClaudeSheet — paste JSON externally generated, no API call
- AskCoachSheet (Trends) — preloads date-range data; supports `<<PROPOSALS>>` blocks for one-tap target updates
- AskWeightSheet (Profile) — weight history context, freeform Q&A
- ModifyWithClaudeSheet (Detail) — recompute macros for a modified meal
- ExerciseLogSheet AI mode — parse freeform workout into structured entries

**Cost estimate** (sonnet-4-6): text-only ~$0.006/log, photo ~$0.012/log, trends Q&A ~$0.014, bulk parse ~$0.028. ~$1.50/month at moderate use.

---

## Recent State (last session)

**Just shipped:**
- Touch long-press drag with vertical-bar handle
- Combine meals via drag (with Undo toast)
- Wellness state per-date (was a single global object — bug)
- Versioned daily targets (per-date snapshots in `target_history`)
- Per-day Edit/select mode on Home with Move/Copy bar
- AI logs land on the user's selected date (not always today)
- Photos in bulk notes get associated to specific meals via `photo_index`
- Star removed from meal rows (favourites still toggleable from food detail)
- Photo delete moved to gallery (Profile), not meal rows
- Modify with Claude positioning fix for iOS device frame quirk
- App fills full screen (removed mock iPhone frame)
- Safe-area top padding so iOS status bar doesn't overlap headers
- Always lands on Today after login
- Trends stacked exercise bars by type with color
- "Ask Claude about my data" sheets on Trends and Weight
- Daily goals include sat fat / sugar / fibre / exercise minutes (kcal removed per user)
- Comprehensive JSON export + CSV export
- Settings: "Add exercise to calorie goal" toggle (eat-back-burned-calories mode)

**Open / known issues:**
- HISTORY is rebuilt from cloud after login — Trends will be empty until first meal logged
- Photos: localStorage limit can drop them; Storage upload is the canonical source
- iOS: HTML5 drag fundamentally doesn't work; touch handle is the only reliable path on iPhone
- Refresh token can expire if user away >1 week — they need to sign in again
- Service worker can serve stale builds; bump `CACHE` in `sw.js` for forced refresh

**Not built (but discussed):**
- Per-ingredient quantity scaling that recomputes parent totals (delete works; full edit works for grams; could be slicker)
- "Split contributors by ingredient" in the protein/etc drilldown so merged meals show as their underlying ingredients
- Native iOS app (PWA is the realistic option without paying $99/yr Apple dev)
- Apple HealthKit pull (PWA can't access HealthKit; would need Health Auto Export app or similar)
- Photo gallery with full-screen carousel / search
- Push notifications for meal/water reminders (would need backend service worker push subscription server)
- Weekly summary email (needs backend)
- Multiple drafts in Bulk Notes
- AI trend analysis: only target-set proposals are wired today; Claude could also propose adding favourites, adjusting exercise entries, etc

**Mockups for future Trends exercise chart redesigns** (PNG previews stored at `/tmp/chartmocks/` last session):
1. Filter chips above stacked bars
2. Side-by-side grouped bars per type
3. Heatmap (types × days)
4. Net calorie balance bar (intake − burn, red surplus / green deficit)
5. Stacked total + per-type sparklines below
6. Per-day donuts

---

## Useful Chrome MCP commands (for next-session debugging)

User's Chrome has the Claude MCP extension active. Common verifications:

```js
// Check if signed in + what tab
(await window.sb.auth.getUser()).data?.user?.email

// Force fresh sign-in as demo
await window.sb.auth.signOut();
await window.sb.auth.signInWithPassword({ email: 'demo@caloree.app', password: 'DEMO_PW_REDACTED' });

// Inspect rows on screen
Array.from(document.querySelectorAll('[data-meal-row-id]')).map(r => r.getAttribute('data-meal-row-id'))

// Clear stale service worker
const regs = await navigator.serviceWorker.getRegistrations();
for (const r of regs) await r.unregister();
const keys = await caches.keys();
for (const k of keys) await caches.delete(k);
location.reload();
```

---

## What to ask Claude in the next session

Open with: *"Read calorie-app/HANDOFF.md to get context."* Then describe what's broken or what you want to build.

If something's broken on the live site, ask Claude to navigate via the Chrome MCP and check console errors — that's how we've caught most regressions.
