-- Additive D1 audit recovery only. Supabase is the authoritative source ledger.
CREATE TABLE IF NOT EXISTS production_outbox (
  store_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('order.completed','refund.succeeded','refund.failed')),
  event_id TEXT NOT NULL,
  event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64),
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(store_id,event_type,event_id)
);
CREATE INDEX IF NOT EXISTS production_outbox_pending ON production_outbox(state,updated_at);
