CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task_created
ON task_comments(task_id, created_at);

CREATE INDEX IF NOT EXISTS idx_task_comments_author_created
ON task_comments(author_user_id, created_at);

ALTER TABLE change_log ADD COLUMN event_type TEXT NULL;
ALTER TABLE change_log ADD COLUMN details_json TEXT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS search_index
USING fts5(entity_type, entity_id UNINDEXED, project_id UNINDEXED, content);
