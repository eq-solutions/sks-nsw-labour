# eq-shell A1 — drop-in: mint Field #sh= tokens carrying canonical_user_id + phone

**Repo:** eq-shell (NOT this repo — separate checkout). **Status:** ready to apply.
**Depends on:** v3.10.59 of this app (already resolves by `canonical_id` → then `phone`).

## What to change
eq-shell already mints a `kind:'shell-token'` HMAC token for the EQ Field `#sh=` handoff
(60s, signed with `EQ_SECRET_SALT`; consumed by this app's `verify-pin.js` → `verifyShellToken`).
**Add two fields to that token's payload:** `canonical_user_id` and `phone`. Nothing else changes —
v3.10.59 reads both and ignores them when absent.

## Token contract (must match verify-pin.js verifyShellToken exactly)
- Format: `base64(JSON.stringify(payload))` + `"."` + `hex(HMAC_SHA256(jsonString, EQ_SECRET_SALT))`
- Required payload fields: `kind:'shell-token'`, `name`, `role`, numeric `exp` (ms, future).
- Optional (NEW): `canonical_user_id`, `phone`, plus existing `tenant_slug`.

```js
const crypto = require('crypto');

// secretSalt MUST be the same value as the SKS Netlify site's EQ_SECRET_SALT.
function mintFieldShellToken({ name, role, tenantSlug, canonicalUserId, phone }, secretSalt) {
  const payloadObj = {
    kind: 'shell-token',
    name,                                   // display name — LABEL ONLY; Field overwrites it
                                            // after resolving the person by id/phone
    role,                                   // 'staff' | 'supervisor'
    tenant_slug: tenantSlug || 'sks',
    canonical_user_id: canonicalUserId || null, // === eq-canonical public.workers.id
    phone: phone || null,                   // fallback join key for pre-claim workers
    exp: Date.now() + 60 * 1000,            // 60s, single-use
  };
  const payload = JSON.stringify(payloadObj);
  const sig = crypto.createHmac('sha256', secretSalt).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}
// Launch Field at:  https://sks-nsw-labour.netlify.app/#sh=<token>
```

## ⚠ Correctness — the id that MUST go in `canonical_user_id`
Use **`public.workers.id`** (eq-canonical `jvknxcmbtrfnxfrwfimn`). After the 2026-06-06 re-sync this
equals `people.canonical_id` on the SKS side for 28 workers. Do **NOT** use:
- `shell_control.users.id` — only 5 rows (suite operators), not the crew.
- `workers.user_id` — the auth id, not the people join key.

For a worker who has **no `workers` row yet** (invite-only / pre-claim), send `phone` and omit
`canonical_user_id`; v3.10.59 falls back to last-9 phone match. Resolution precedence in Field:
`canonical_id` (UUID) → `phone` (last-9) → name (existing gate).

## Gate 0 — salt parity (BLOCKER, human verification)
- `verify-pin` is **deployed** on the SKS Netlify site (confirmed 2026-06-06).
- `EQ_SECRET_SALT` on the SKS site MUST equal the salt eq-shell signs Field tokens with.
  ⚠ eq-canonical `shell_control.iframe_salt_registry` tracks rotating salts (`EQ_SECRET_SALT_A/B`).
  If eq-shell signs Field tokens with a rotating salt, the SKS site's single `EQ_SECRET_SALT`
  must match the **currently active** one, or every token is rejected. Confirm before launch.
- Also confirm `STAFF_CODE` / `MANAGER_CODE` set on the SKS site (unrelated to SSO but required by verify-pin).

## Acceptance
1. Shell launches Field for a synced worker → lands on their schedule, zero taps.
2. Shell launches Field for an invite-only worker (phone only) → resolves by phone.
3. Bad/expired token → silently falls through to the shared-code gate (no breakage).
