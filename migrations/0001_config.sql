CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  updated_at TEXT NOT NULL
);
INSERT INTO config (id, version, config_json, updated_at)
VALUES (1, 1, '{"activeUpstreamId":null,"upstreams":[],"accessKeys":[]}', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
