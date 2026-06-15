CREATE TABLE IF NOT EXISTS telegram_chat_state (
    chat_id INTEGER PRIMARY KEY,
    pending_action TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
