# Production Hardening Audit - 2026-04-29

## Applied now

- Hardened migration wallet validation to require a valid ANET wallet format.
- Blocked reuse of migration wallet addresses across other user wallet fields.
- Moved `POST /mining/claim` onto a database transaction with `FOR UPDATE` locking.
- Claim eligibility now requires at least 1000 verified completed mining sessions, not only `successful_sessions`.
- Added `ant_transactions` ledger writes for completed mining claims.
- Preserved the public demo blockchain endpoint and added live backend transparency endpoints:
  - `/blockchain/testnet` = demo-only preview
  - `/blockchain/final` = production transparency summary
  - `/blockchain/transparency` = production transparency summary

## Audit result

The Android app is broadly Play-safe, but backend economic hardening is still in progress.

### Ready enough now

- Minimal Android permissions.
- HTTPS-only API enforcement in the Flutter app.
- Session nonce and device-binding checks in auth middleware.
- Request-flood mitigations on hot routes.

### Still not fully complete

- No full Web2-to-L1 settlement state machine was found in the active backend routes.
- No end-to-end cashout queue, broadcast, confirmation, and reconciliation flow was found in the active backend routes.
- Migration wallet validation is now stricter, but on-chain ownership or chain existence verification is still not implemented.
- Public transparency is backend-summary transparency, not chain-finality transparency.

## Current risk summary

### Medium

- Users can only claim after verified completed sessions now, but broader payout and migration state transitions still need explicit idempotent workflow tables.
- Ads impression abuse detection exists, but automatic hard shutdown or daily abuse caps are still limited.

### Low

- Demo blockchain exposure remains public by choice. It is now explicitly labeled as demo data.

## Recommended next build

1. Add a settlement table for migration and cashout requests with statuses: `requested`, `validated`, `queued`, `broadcast`, `confirmed`, `settled`, `failed`.
2. Add idempotency keys for every migration or payout request.
3. Reconcile backend claim and migration totals against the chain/explorer service.
4. Add hard daily caps and automatic suspension on repeated ad-impression abuse.
5. Split transparency into backend-summary and independent chain-summary once the chain integration is live.