CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'viewer')),
    telegram_id TEXT NULL,
    display_name TEXT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_login_at TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id
ON users(telegram_id)
WHERE telegram_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NULL,
    action TEXT NOT NULL,
    entity_type TEXT NULL,
    entity_id INTEGER NULL,
    details_json TEXT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

ALTER TABLE tasks ADD COLUMN author_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN deleted_at TEXT NULL;
ALTER TABLE tasks ADD COLUMN updated_at TEXT NULL;

ALTER TABLE ideas ADD COLUMN author_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ideas ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ideas ADD COLUMN deleted_at TEXT NULL;
ALTER TABLE ideas ADD COLUMN updated_at TEXT NULL;

ALTER TABLE notes ADD COLUMN author_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notes ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN deleted_at TEXT NULL;
ALTER TABLE notes ADD COLUMN updated_at TEXT NULL;

ALTER TABLE decisions ADD COLUMN author_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE decisions ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE decisions ADD COLUMN deleted_at TEXT NULL;
ALTER TABLE decisions ADD COLUMN updated_at TEXT NULL;

ALTER TABLE links ADD COLUMN author_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE links ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN deleted_at TEXT NULL;
ALTER TABLE links ADD COLUMN updated_at TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_author_id ON tasks(author_id);
CREATE INDEX IF NOT EXISTS idx_ideas_author_id ON ideas(author_id);
CREATE INDEX IF NOT EXISTS idx_notes_author_id ON notes(author_id);
CREATE INDEX IF NOT EXISTS idx_decisions_author_id ON decisions(author_id);
CREATE INDEX IF NOT EXISTS idx_links_author_id ON links(author_id);
