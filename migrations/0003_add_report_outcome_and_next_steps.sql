ALTER TABLE reports ADD COLUMN outcome TEXT NOT NULL DEFAULT 'resolved'
  CHECK (outcome IN ('resolved', 'inconclusive'));

ALTER TABLE reports ADD COLUMN suggested_next_steps_json TEXT NOT NULL DEFAULT '[]';
