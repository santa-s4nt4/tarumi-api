CREATE TABLE gps_links (
  id TEXT PRIMARY KEY,
  reader TEXT NOT NULL,
  writer TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  fix_time INTEGER NOT NULL DEFAULT 0,
  fix TEXT
);
CREATE INDEX gps_links_expiry ON gps_links(expires_at);
