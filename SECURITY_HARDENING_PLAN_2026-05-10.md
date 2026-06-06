# Web2 Backend Security Hardening Plan - 2026-05-10

## Critical Issues Found

### 1. **PUBLIC MINING STATUS ENDPOINT** 🔴 CRITICAL
**File:** `routes/mining.js` - `/status/:userId` endpoint
**Issue:** Anyone can query any user's mining status without authentication
**Impact:** User privacy leak; session counter can be enumerated
**Risk:** High
```javascript
fastify.get('/status/:userId', async (req) => {
  // NO AUTHENTICATION - PUBLICLY ACCESSIBLE
  const { userId } = req.params;
  // ...returns mining data for ANY userId
});
```
**Fix:** Add `{ preHandler: verifyToken }` and validate `req.user.userId === userId`

---

### 2. **JWT VERIFICATION WITHOUT PROPER ERROR HANDLING** 🟡 MEDIUM
**File:** `middleware/auth.js`
**Issues:**
- Returns `{ error: "..." }` instead of HTTP error codes
- No token expiration validation (should check `exp` claim)
- No token revocation/blacklist
- No device binding enforcement

**Fix:** Return proper HTTP 401/403 status codes, add exp validation, implement token blacklist

---

### 3. **MISSING SECURITY HEADERS** 🟡 MEDIUM
**File:** `backend/server.js`
**Missing:** HSTS, CSP, X-Frame-Options, X-Content-Type-Options
**Fix:** Add helmet.js or manual security headers

---

### 4. **NO RATE LIMITING PER USER** 🟡 MEDIUM
**File:** `backend/server.js`
**Issue:** Global rate limit only; no per-user or per-session rate limit
**Impact:** DDoS on specific endpoints (mining claim spam, stats queries)
**Fix:** Add per-user rate limits on `/mining/complete`, `/stats/user/*`

---

### 5. **NO IP SPOOFING PROTECTION ON MINING COMPLETION** 🟡 MEDIUM
**File:** `routes/mining.js` - `/complete` endpoint
**Issue:** Captures `last_ip` but doesn't validate consistency
**Fix:** Require matching IP between start and complete; flag if different

---

### 6. **MISSING SESSION TIME RANDOMIZATION** 🟡 MEDIUM
**File:** `routes/mining.js`
**Issue:** Hardcoded 6-hour mining time (21600 seconds) is predictable
**Fix:** Add ±5-10 minute randomization to prevent timing attacks

---

### 7. **NO INPUT VALIDATION/SANITIZATION** 🟡 MEDIUM
**Files:** All route handlers
**Issue:** No schema validation on `userId`, numeric inputs, strings
**Fix:** Add `@fastify/cors`, `joi` or `zod` for schema validation

---

### 8. **DATABASE SECRETS EXPOSURE RISK** 🟡 MEDIUM
**File:** `.env` (not in repo, but referenced)
**Issue:** No secrets rotation, no minimum entropy validation
**Fix:** Enforce min 32-char JWT_SECRET, rotate quarterly

---

### 9. **MISSING IDEMPOTENCY KEYS** 🟡 MEDIUM
**File:** All POST endpoints (mining claim, stats submission, etc.)
**Issue:** No idempotency mechanism; duplicate requests could double-process claims
**Fix:** Add `Idempotency-Key` header validation with 24-hour cache

---

### 10. **NO AUDIT LOGGING** 🟡 MEDIUM
**File:** All route handlers
**Issue:** Security events not logged (auth failures, claim attempts, IP changes)
**Fix:** Add comprehensive audit log to separate table with timestamps, IPs, user IDs

---

## Recommended Next Steps (Priority Order)

### Phase 1 - CRITICAL (Do Today)
1. ✅ Fix `/status/:userId` endpoint to require auth + user ownership check
2. ✅ Add proper HTTP error codes in auth middleware (401/403)
3. ✅ Add security headers (helmet.js or manual)

### Phase 2 - HIGH (Do This Week)
4. Add per-user rate limiting on mining endpoints
5. Add IP consistency check on mining completion
6. Add input validation with joi/zod on all routes
7. Add token expiration validation in auth middleware
8. Add audit logging for security events

### Phase 3 - MEDIUM (Do Next Sprint)
9. Implement idempotency keys for POST operations
10. Add session time randomization (±5-10 min)
11. Implement token revocation/blacklist
12. Add device-binding enforcement

### Phase 4 - NICE-TO-HAVE (Future)
13. Secret rotation automation
14. Advanced fraud detection (velocity checks, geographic anomalies)
15. Rate limit escalation (temp IP blocks like ads route)

---

## Implementation Priority Matrix

| Issue | Severity | Effort | ROI | Action |
|-------|----------|--------|-----|--------|
| Public mining status | CRITICAL | Low | High | **Fix today** |
| HTTP error codes | HIGH | Low | High | **Fix today** |
| Security headers | HIGH | Low | High | **Fix today** |
| Per-user rate limit | HIGH | Medium | High | **Fix this week** |
| Input validation | HIGH | Medium | High | **Fix this week** |
| IP spoofing check | MEDIUM | Low | Medium | **Fix this week** |
| Audit logging | MEDIUM | Medium | Medium | **Next sprint** |
| Session randomization | MEDIUM | Low | Medium | **Next sprint** |
| Idempotency keys | MEDIUM | High | Medium | **Next sprint** |

---

## Compliance Checklist

- [ ] No unauthenticated endpoints return sensitive user data
- [ ] All POST endpoints have idempotency protection
- [ ] JWT tokens have exp claims + validation
- [ ] All errors return proper HTTP status codes (not 200 with error JSON)
- [ ] Security headers present (HSTS, CSP, X-Frame-Options)
- [ ] Rate limiting per-user on sensitive endpoints
- [ ] All inputs validated with schema (joi/zod)
- [ ] Audit log table exists with security events
- [ ] IP consistency checked on multi-step operations (mining start → complete)
- [ ] Device fingerprint binding on sessions (if mobile)
- [ ] JWT_SECRET minimum 32 characters, alphanumeric + special chars
- [ ] Database SSL enforced (rejectUnauthorized = true in prod)

---

## Deployment Checklist

Before going live:
1. Run security scan: `npm audit`
2. Verify all env vars set correctly in Render dashboard
3. Enable HTTPS-only in mobile app (already done)
4. Test all fixed endpoints with curl/Postman
5. Check audit logs for suspicious activity in first 24h post-deploy
6. Monitor for unusual rate-limit triggers

---

## Quick Fixes Available (Next Turn)

Want me to implement these patches now?
- [ ] Fix public mining status endpoint
- [ ] Add HTTP error codes to auth.js
- [ ] Add security headers to server.js
- [ ] Add input validation to routes
- [ ] Add per-user rate limiting

