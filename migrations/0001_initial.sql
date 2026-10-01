PRAGMA foreign_keys = ON;

CREATE TABLE tokens (
  annotator_id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE annotators (
  annotator_id TEXT PRIMARY KEY,
  completed_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE completed_pairs (
  annotator_id TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (annotator_id, pair_id),
  FOREIGN KEY (annotator_id) REFERENCES annotators(annotator_id) ON DELETE CASCADE
);

CREATE TABLE seen_gold (
  annotator_id TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (annotator_id, pair_id),
  FOREIGN KEY (annotator_id) REFERENCES annotators(annotator_id) ON DELETE CASCADE
);

CREATE TABLE repeat_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  annotator_id TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  target_at_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (annotator_id) REFERENCES annotators(annotator_id) ON DELETE CASCADE
);

CREATE INDEX repeat_queue_due
  ON repeat_queue (annotator_id, target_at_count, id);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  annotator_id TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  response TEXT NOT NULL CHECK (response IN ('left', 'right', 'cant_tell')),
  surprise_choice TEXT CHECK (surprise_choice IN ('left', 'right', 'none')),
  left_url TEXT,
  right_url TEXT,
  left_surprise INTEGER CHECK (left_surprise BETWEEN 1 AND 5),
  right_surprise INTEGER CHECK (right_surprise BETWEEN 1 AND 5),
  attention_json TEXT,
  is_gold INTEGER NOT NULL DEFAULT 0 CHECK (is_gold IN (0, 1)),
  gold_expected TEXT CHECK (gold_expected IN ('left', 'right')),
  gold_correct INTEGER CHECK (gold_correct IN (0, 1)),
  is_repeat INTEGER NOT NULL DEFAULT 0 CHECK (is_repeat IN (0, 1)),
  repeat_of TEXT,
  presented_time TEXT,
  timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  response_time_ms INTEGER,
  stage_durations_json TEXT,
  FOREIGN KEY (annotator_id) REFERENCES annotators(annotator_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX one_original_annotation_per_pair
  ON annotations (annotator_id, pair_id)
  WHERE is_gold = 0 AND is_repeat = 0;

CREATE INDEX annotations_gold
  ON annotations (annotator_id, is_gold);

CREATE INDEX annotations_repeat
  ON annotations (annotator_id, is_repeat, pair_id);
