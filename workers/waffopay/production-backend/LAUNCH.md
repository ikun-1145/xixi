# Waffo Production release — 2026-10-02

`../AUDIT.md` is historical Test preparation evidence from 2026-09-30. Production now uses `production.js`, `payment-proof.js`, `production-rpc.js`, and the applied migration `20261002071010_waffo_production_entitlement_sources.sql`.

Production checkout is `/checkout/waffo/production`; `/checkout/waffo` remains Test-only. Public frontend switches and Production entitlement are enabled. No E2E subject whitelist remains. Production uses independent API/webhook keys and the fixed official product, CNY 1500 minor units.

Signed webhook amounts plus official GraphQL Merchant/Store/Product/mode/order/payment/refund and external intent checks precede every entitlement operation. PostgreSQL locks the profile and atomically projects order-scoped Waffo sources; D1 only atomically saves its own audit/outbox. Pending outbox deliveries retry every five minutes with fresh provider proof. No cross-database atomicity is claimed.

Existing Pro users are preserved as `legacy` sources. Non-Waffo payment, activation-code and manual writes are conservatively captured as `other` sources; they are not historically relabeled as individual channels. Refunds disable only `waffo/<order_id>` and do not remove active non-Waffo sources. Completion cannot resurrect refunded or manually revoked orders.

Migration verification preserved all 21 pre-existing Pro users, enabled RLS on five private tables and restricted the three new RPCs to service_role. One pre-migration, unpaid D1 intent was idempotently registered in PostgreSQL without payment proof or entitlement changes.

Checks: 671 full tests, 254 Waffo/return/public-checkout tests, 26 Production and 37 Test dangerous mutations, and 48 local PostgreSQL source/refund/recovery checks passed. Live browser purchase created a Production checkout showing CN¥15.00 and the configured Product. Authenticated unknown-order status returned paymentConfirmed=false; checkout without idempotency key returned 400. Missing/invalid authentication and unsigned/bad-signature webhooks returned 401; allowed/foreign origins returned 204/403.

No real payment or refund was performed. Actual provider payment/webhook/GraphQL execution and real PostgreSQL multi-connection concurrency were not exercised by the no-charge smoke; local failure/reorder/idempotency tests do not substitute for those production observations.

Dashboard Product return link: https://sunland.dev/waffo-return.html . The API additionally supplies an opaque checkout fragment for owner-authenticated server status lookup. Missing/unknown context returns silently to /ai.html; URL parameters never authorize Pro.
