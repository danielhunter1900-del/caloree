-- ======= Rehab Section Tables =======
-- Run in Supabase SQL editor (Dashboard > SQL Editor > New query)

-- 1. Rehab programs
CREATE TABLE IF NOT EXISTS rehab_programs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  name         TEXT NOT NULL,
  notes        TEXT,
  color_key    TEXT DEFAULT 'acc',
  is_active    BOOLEAN DEFAULT true,
  created_at   DATE DEFAULT CURRENT_DATE
);
ALTER TABLE rehab_programs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_programs" ON rehab_programs FOR ALL USING (auth.uid() = user_id);

-- 2. Exercises within a program
CREATE TABLE IF NOT EXISTS rehab_exercises (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id          UUID NOT NULL REFERENCES rehab_programs ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  name                TEXT NOT NULL,
  emoji               TEXT,
  color_key           TEXT DEFAULT 'acc',
  current_stage       INT DEFAULT 1,
  total_stages        INT DEFAULT 1,
  sets                INT DEFAULT 3,
  reps                INT DEFAULT 10,
  hold_secs           INT,
  resistance_type     TEXT DEFAULT 'bodyweight', -- bodyweight | band | weight | time
  band_level          TEXT,                       -- light | medium | heavy | x-heavy
  weight_kg           NUMERIC,
  frequency_per_week  INT DEFAULT 3,
  frequency_days      TEXT[],                     -- e.g. ARRAY['Mon','Wed','Fri']
  notes               TEXT,
  created_at          DATE DEFAULT CURRENT_DATE
);
ALTER TABLE rehab_exercises ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_exercises" ON rehab_exercises FOR ALL USING (auth.uid() = user_id);

-- 3. Session logs (one row per exercise per session)
CREATE TABLE IF NOT EXISTS rehab_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id   UUID NOT NULL REFERENCES rehab_exercises ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  sets_done     INT,
  reps_per_set  NUMERIC[],
  pain_score    NUMERIC,       -- 0–10
  stage_at_log  INT,
  band_level    TEXT,
  weight_kg     NUMERIC,
  notes         TEXT,
  logged_date   DATE DEFAULT CURRENT_DATE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE rehab_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_sessions" ON rehab_sessions FOR ALL USING (auth.uid() = user_id);

-- 4. Physio appointments
CREATE TABLE IF NOT EXISTS physio_appointments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  name              TEXT DEFAULT 'Physio',
  appointment_date  DATE,
  appointment_time  TIME,
  clinic            TEXT,
  notes             TEXT,
  discussion_items  JSONB DEFAULT '[]'::JSONB
);
ALTER TABLE physio_appointments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_appointments" ON physio_appointments FOR ALL USING (auth.uid() = user_id);

-- 5. Exercise progression stages
CREATE TABLE IF NOT EXISTS exercise_progression_stages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id   UUID NOT NULL REFERENCES rehab_exercises ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  stage_number  INT NOT NULL,
  stage_name    TEXT,
  target_sets   INT,
  target_reps   INT,
  band_level    TEXT,
  weight_kg     NUMERIC,
  description   TEXT,
  achieved_at   DATE
);
ALTER TABLE exercise_progression_stages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_stages" ON exercise_progression_stages FOR ALL USING (auth.uid() = user_id);
