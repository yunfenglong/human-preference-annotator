-- Local-development tokens only. Production annotators should be created in /admin/.
INSERT OR IGNORE INTO tokens (annotator_id, token) VALUES
  ('alice@student.uts.edu.au', 'ffb981fe'),
  ('bob@student.uts.edu.au', '664f0149'),
  ('ste@student.uts.edu.au', 'ac06a7b7');
