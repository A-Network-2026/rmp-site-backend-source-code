# Production Deploy Checklist – rmp-site (Node.js backend)
## DO NOT SKIP ANY STEP

---

## Pre-Deploy (5 min)
- [ ] No uncommitted changes: `git status --short`
- [ ] Note current commit hash for rollback: `git rev-parse HEAD`
- [ ] Confirm `render.yaml` test flags are all `false`:
  - `PI_ENABLE_TEST_ADMIN: "false"`
  - `PI_ALLOW_TEST_ASSET_MINT: "false"`
  - `PI_ALLOW_INELIGIBLE_FOR_DEX_TEST: "false"`
- [ ] Confirm all admin key comparisons use `safeKeyEqual()` in `src/server.js`
- [ ] Confirm CORS is not wildcard (`*`) in production
- [ ] Run migration check: confirm no pending schema migrations
- [ ] Verify `.env` secrets are set on Render (not committed to repo)

## Deploy
- [ ] Push to main (triggers Render auto-deploy)
- [ ] Open Render dashboard → confirm new deploy triggered
- [ ] Wait for build to complete (~1 min)
- [ ] Check deploy logs: zero ERROR lines at startup

## Post-Deploy Health (10 min)
- [ ] `/stats/network` → HTTP 200
- [ ] `/mining/status/:userId` (with valid auth) → HTTP 200
- [ ] `/pi/payment-complete` health check (sandbox only)
- [ ] Database connections stable (check Render metrics — no connection pool exhaustion)
- [ ] Auth 401 ratio remains at baseline (no spike in errors)

## Rollback
```bash
git revert <HASH>
git push origin main
# Or: Render dashboard → Manual Deploy → select previous deploy
```

## Schema Rollback (if migration was applied)
```sql
-- Example: remove a column safely
ALTER TABLE users DROP COLUMN IF EXISTS <column_name>;
```

## Approval
Date: ______ | Approver: ______ | Commit: ______
