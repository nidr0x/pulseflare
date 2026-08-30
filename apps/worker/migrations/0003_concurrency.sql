ALTER TABLE scheduler_lease ADD COLUMN owner_id TEXT;
ALTER TABLE notification_outbox ADD COLUMN claimed_by TEXT;
ALTER TABLE notification_outbox ADD COLUMN claimed_until TEXT;

CREATE INDEX IF NOT EXISTS notification_outbox_claim_idx
  ON notification_outbox(status, next_attempt_at, claimed_until);
