# Production payment proof

Official contracts checked 2026-10-02:
- https://github.com/waffo-com/waffo-pancake-sdk-ts/blob/main/docs/webhook-guide.md
- https://github.com/waffo-com/waffo-pancake-sdk-ts/blob/main/docs/graphql-guide.md

Signed chargedAmount and listPrice.total must both be CNY 15 in display units with valid arithmetic. Deprecated amount is never a fallback. Signed GraphQL must establish actual Product, Store, Merchant relationship, Production testMode=false, completed order, succeeded matching payment, external intent and absence of successful/pending/unknown refunds. Errors fail closed; an observed ledger entry alone never becomes a proof.

## Refund/grant atomicity (former release blocker, resolved)

The earlier candidate granted through the legacy two-argument Pro RPC from D1, so a refund could commit between separate transaction boundaries. Replaced by a Supabase-authoritative source ledger (`waffo_prod`): grant, refund tombstone and the `pro` projection are one PG transaction under the profile row lock. Order state is monotonic (pending → granted → refunded); events are idempotent by `(event_type,event_id)` with content hash conflict detection. A trigger captures every non-Waffo Pro write as a separate source, so revoking a Waffo order keeps Afdian/activation/manual Pro. The migration refuses to run if the live legacy payment RPC definition differs from the audited hash.
