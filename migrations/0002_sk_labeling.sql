-- Isolated SK3 records: legacy driving judgments cannot enter this export.
CREATE TABLE sk_exports (
  export_id TEXT PRIMARY KEY,
  settings_sha256 TEXT NOT NULL
);
CREATE TABLE sk_viewers (
  viewer_id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL
);
CREATE TABLE sk_sessions (
  id TEXT PRIMARY KEY,
  viewer_id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (viewer_id, export_id),
  FOREIGN KEY (viewer_id) REFERENCES sk_viewers(viewer_id)
);
CREATE TABLE sk_trials (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  clip_id TEXT NOT NULL,
  is_repeat INTEGER NOT NULL CHECK (is_repeat IN (0, 1)),
  issued_at TEXT NOT NULL,
  answered_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sk_sessions(id)
);
CREATE UNIQUE INDEX sk_one_pending_viewer_trial ON sk_trials(export_id, viewer_id) WHERE answered_at IS NULL;
CREATE TABLE sk_responses (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id TEXT NOT NULL UNIQUE,
  export_id TEXT NOT NULL,
  task TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('A', 'B', 'tie', 'uncertain', 'technical_failure')),
  playback_complete INTEGER NOT NULL CHECK (playback_complete IN (0, 1)),
  is_repeat INTEGER NOT NULL CHECK (is_repeat IN (0, 1)),
  timestamp TEXT NOT NULL,
  FOREIGN KEY (response_id) REFERENCES sk_trials(id)
);
CREATE UNIQUE INDEX sk_primary_viewer_task
  ON sk_responses(export_id, viewer_id, task) WHERE is_repeat = 0;
CREATE INDEX sk_export_sequence ON sk_responses(export_id, sequence);
