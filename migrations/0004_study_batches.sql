-- R2 batch directories are selected by the operator, independently of export hashes.
CREATE TABLE sk_batches (
  batch TEXT PRIMARY KEY,
  export_id TEXT NOT NULL,
  settings_json TEXT NOT NULL
);
CREATE TABLE sk_active_batch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  batch TEXT NOT NULL REFERENCES sk_batches(batch)
);
