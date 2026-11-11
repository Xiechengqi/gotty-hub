CREATE TABLE terminal_settings(
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0)
);
