CREATE UNIQUE INDEX instances_owner_name ON instances(owner_id, name COLLATE NOCASE);
