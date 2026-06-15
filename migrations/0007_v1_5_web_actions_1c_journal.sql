CREATE INDEX IF NOT EXISTS idx_processed_1c_events_event_id
ON processed_1c_events(event_id);

CREATE INDEX IF NOT EXISTS idx_processed_1c_events_processed_at
ON processed_1c_events(processed_at);
