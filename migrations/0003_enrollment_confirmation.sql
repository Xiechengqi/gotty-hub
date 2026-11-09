ALTER TABLE enrollments ADD COLUMN initial_grants TEXT NOT NULL DEFAULT '[]';
ALTER TABLE enrollments ADD COLUMN confirmed_instance TEXT;
