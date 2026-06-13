ALTER TABLE tasks ADD COLUMN due_soon_notified_at TEXT NULL;
ALTER TABLE tasks ADD COLUMN overdue_notified_at TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_due_status_deleted
ON tasks(due_date, status, is_deleted);

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_due_status
ON tasks(assignee_id, due_date, status);
