ALTER TABLE sk_batches ADD COLUMN assignment_sha256 TEXT;
CREATE TABLE sk_viewer_groups (
  export_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  assignment_sha256 TEXT NOT NULL,
  PRIMARY KEY (export_id, viewer_id)
);
