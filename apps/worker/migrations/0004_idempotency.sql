CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_open_per_service_idx
  ON incidents(service_id)
  WHERE status = 'open';

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_delivery_idx
  ON notification_outbox(incident_id, provider_id, event);
