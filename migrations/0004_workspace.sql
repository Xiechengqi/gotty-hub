CREATE TABLE workspace_revisions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    write_id TEXT NOT NULL
);
CREATE TABLE workspace_members (
    user_id TEXT NOT NULL REFERENCES workspace_revisions(user_id) ON DELETE CASCADE,
    instance TEXT NOT NULL,
    unit_position INTEGER NOT NULL,
    member_position INTEGER NOT NULL,
    group_id TEXT,
    hidden INTEGER NOT NULL CHECK (hidden IN (0, 1)),
    PRIMARY KEY (user_id, instance),
    FOREIGN KEY (instance, user_id) REFERENCES grants(instance, user_id) ON DELETE CASCADE
);
CREATE INDEX workspace_members_order ON workspace_members(user_id, unit_position, member_position);
CREATE INDEX workspace_members_grant ON workspace_members(instance, user_id);

CREATE TABLE workspace_writes (
    user_id TEXT NOT NULL REFERENCES workspace_revisions(user_id) ON DELETE CASCADE,
    write_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (user_id, write_id)
);

CREATE TRIGGER workspace_grant_removed BEFORE DELETE ON grants
WHEN EXISTS (SELECT 1 FROM workspace_members WHERE user_id = OLD.user_id AND instance = OLD.instance)
BEGIN
    UPDATE workspace_revisions SET revision = revision + 1 WHERE user_id = OLD.user_id;
END;
