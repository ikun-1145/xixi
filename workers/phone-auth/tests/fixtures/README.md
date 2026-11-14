# Isolated phone initialization fixtures

These are schema-only test fixtures. They are **not migrations** and must not be
applied to production. They contain no production rows, credentials, user data,
or actual key material.

- `phone-identity-reviewed.sql` is the phone migration from xixi local commit
  `bb0dca1:supabase/migrations/20261024003756_phone_identity.sql`, whose phone
  RPC and trigger were previously compared with production catalog definitions.
  SHA-256: `0022b4274f19dc61de8b53c2023aa0e5f1668aeb6f69868131063983cafce835`.
- `related-triggers-reviewed.sql` extracts only the seven directly used table
  definitions and trigger functions/definitions from
  `ikun-1145/sunland-ai-dart@12767557f4e326dedf13378c1369934f17a48197`
  (quota and conversation migrations) and
  `ikun-1145/xixi@e32eb5f0bf18428418c5c22ce0572c9024ca9a85`
  (Waffo migration). `set_updated_at` is an equivalent synthetic definition
  checked against the observed function body, not an export of customer data.
  SHA-256: `d85be85c8800d03e527db384dff138ae6f989ecb2e4b6e65de4220be88902132`.

CI creates a fresh, disposable PostgreSQL 17 container with synthetic credentials
and data, and covers the actual phone schema, six related triggers, RLS enablement,
concurrent initializer locking, refusal to overwrite, and the real phone RPC's
advisory lock. The profile/deletion tables and directly related dependencies are
reconstructed from reviewed definitions. **This is not a complete production
Supabase schema, a production ACL/extension/trigger inventory, a full restore
rehearsal, or evidence of production key recovery.** Revalidate the schema-only
fixtures against the deployed catalog before relying on them.
