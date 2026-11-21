CREATE INDEX scheduler_runs_completed_finished_idx
  ON scheduler_runs(finished_at DESC)
  WHERE status IN ('succeeded', 'failed');

CREATE INDEX incidents_resolved_order_idx
  ON incidents(resolved_at DESC, id DESC)
  WHERE status = 'resolved';
