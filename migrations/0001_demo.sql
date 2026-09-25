-- 実際の樽見鉄道の位置・時刻とは関係のない架空データ。
CREATE TABLE demo_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  eta_seconds INTEGER NOT NULL CHECK (eta_seconds >= 0)
);

INSERT INTO demo_events (id, type, name, eta_seconds) VALUES
  ('tunnel-demo', 'tunnel', 'ダミートンネル', 25),
  ('river-demo', 'river', 'ダミー川', 70),
  ('station-demo', 'station', 'ダミー駅', 160);
