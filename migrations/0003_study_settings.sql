CREATE TABLE study_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cant_tell INTEGER NOT NULL DEFAULT 1 CHECK (cant_tell IN (0, 1)),
  surprise INTEGER NOT NULL DEFAULT 1 CHECK (surprise IN (0, 1)),
  attention INTEGER NOT NULL DEFAULT 1 CHECK (attention IN (0, 1))
);

INSERT INTO study_settings (id) VALUES (1);
