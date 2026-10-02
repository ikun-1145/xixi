-- Dedicated D1 ledger. No Supabase, Auth, Pro or Afdian tables or grants.
CREATE TABLE payment_intents (
  payment_reference TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK(mode='prod'),
  user_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(currency='CNY'),
  amount_minor INTEGER NOT NULL CHECK(amount_minor=1500),
  request_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id,request_key)
);
CREATE TABLE event_ledger (
  mode TEXT NOT NULL CHECK(mode='prod'),
  store_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('order.completed','refund.succeeded','refund.failed')),
  event_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  order_id TEXT,
  payment_id TEXT,
  reported_reference TEXT,
  bound_reference TEXT REFERENCES payment_intents(payment_reference),
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64),
  event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64),
  observation TEXT NOT NULL CHECK(observation IN ('valid','invalid','unbound')),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(store_id,event_type,event_id)
);
