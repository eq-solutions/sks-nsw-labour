// ─────────────────────────────────────────────────────────────
// netlify/functions/verify-pin.js
// PIN verification, session token generation, remember-me tokens.
// Env vars required:
//   EQ_SECRET_SALT   — HMAC signing key
//   AUDIT_SB_URL     — Supabase REST URL for audit logging
//   AUDIT_SB_KEY     — Supabase publishable key for audit logging
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

// ── Config from env vars (no fallbacks — fail explicitly) ────
const SECRET_SALT = process.env.EQ_SECRET_SALT;
const SB_URL      = process.env.AUDIT_SB_URL;
const SB_KEY      = process.env.AUDIT_SB_KEY;

// Stage-1 org-JWT minter — nspbmir anon-CRUD lockdown prep (ships DARK).
// Set ORG_JWT_ENABLED=on + NSPBMIR_JWT_SECRET + ORG_IDS_JSON to activate.
// Royce action: get JWT Secret from Supabase → nspbmir → Settings → API
//   and set NSPBMIR_JWT_SECRET as a secret env var on sks-nsw-labour.netlify.app.
//   ORG_IDS_JSON example: '{"sks":"<organisations.id uuid for the sks org>"}'
const NSPBMIR_JWT_SECRET = process.env.NSPBMIR_JWT_SECRET;
const ORG_JWT_ENABLED    = (process.env.ORG_JWT_ENABLED || '').trim().toLowerCase() === 'on';
let ORG_IDS = {};
try {
  const raw = process.env.ORG_IDS_JSON;
  if (raw) ORG_IDS = JSON.parse(raw);
} catch (e) { console.error('WARN: ORG_IDS_JSON parse failed:', e.message); }

if (!SECRET_SALT) console.error('FATAL: EQ_SECRET_SALT env var not set');

// ── Allowed origins for CORS ─────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://sks-nsw-labour.netlify.app',
  'https://eq-solves-field.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000',
];

function corsHeaders(event) {
  const origin = event.headers['origin'] || event.headers['Origin'] || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin === o || origin.endsWith('--sks-nsw-labour.netlify.app') || origin.endsWith('--eq-solves-field.netlify.app'));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, x-eq-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

// ── PIN codes (plaintext, from env vars per tenant) ──────────
// Each Netlify project sets STAFF_CODE / MANAGER_CODE for its tenant.
// SECRET_SALT above is still used for session-token signing (see signToken).
const STAFF_CODE   = process.env.STAFF_CODE;
const MANAGER_CODE = process.env.MANAGER_CODE;

// ── Rate limiting (in-memory, best-effort) ───────────────────
const attempts = {};
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 15 * 60 * 1000;

// ── Audit logging ────────────────────────────────────────────
async function logAttempt(name, success, ip, detail) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/audit_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        action: success ? 'Login success' : 'Login failed',
        category: 'Auth',
        detail: `Name: ${name || 'unknown'}, IP: ${ip || 'unknown'}${detail ? ', ' + detail : ''}`,
        who: name || 'unknown'
      })
    });
  } catch (e) { /* non-blocking */ }
}

// ── Token signing & verification ─────────────────────────────
function signToken(name, role, expiresAt, extra) {
  // `extra` carries optional claims (e.g. { canonical_id }) so the 7-day
  // session token preserves the canonical identity across reloads. Older
  // tokens without it stay valid — verifyToken just returns undefined for
  // the missing field and the client falls back to name-based resolution.
  const payload = JSON.stringify(Object.assign({ name, role, exp: expiresAt }, extra || {}));
  const sig = crypto.createHmac('sha256', SECRET_SALT).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}

function verifyToken(token) {
  try {
    const parts = (token || '').split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sig] = parts;
    const payload = Buffer.from(payloadB64, 'base64').toString();
    const expectedSig = crypto.createHmac('sha256', SECRET_SALT).update(payload).digest('hex');
    // Constant-time compare — match the pattern in approve-leave.js so an
    // attacker can't deduce expectedSig byte-by-byte via response timing.
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const data = JSON.parse(payload);
    if (data.exp < Date.now()) return null;
    return data;
  } catch (e) { return null; }
}

// EQ Shell iframe handoff (Phase 1.C) — ported from eq-solves-field.
// Shell mints a 60s HMAC token signed with the same EQ_SECRET_SALT and
// passes it via URL hash (#sh=<token>). The client calls this action to
// swap it for a 7d session token, skipping the PIN gate entirely.
// tenant_slug is optional — if present it is passed through so the client
// can cross-check it against TENANT.ORG_SLUG before granting access.
function verifyShellToken(token) {
  try {
    const [payloadB64, sig] = (token || '').split('.');
    if (!payloadB64 || !sig) return null;
    const payload = Buffer.from(payloadB64, 'base64').toString();
    const expectedSig = crypto.createHmac('sha256', SECRET_SALT).update(payload).digest('hex');
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const data = JSON.parse(payload);
    if (data.kind !== 'shell-token') return null;
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    if (!data.name || !data.role) return null;
    if (data.tenant_slug != null && typeof data.tenant_slug !== 'string') return null;
    return data;
  } catch (e) { return null; }
}

// ── Org-JWT minter (Stage-1 nspbmir lockdown) ───────────────
// Mints a short-lived (15 min) Supabase HS256 JWT for the nspbmir data plane
// (project nspbmirochztcjijmcrx). The client swaps its anon SB_KEY for this
// token so Supabase receives `role: 'authenticated'` on all data-plane calls,
// enabling org-scoped RLS policies to gate rows instead of the current
// wide-open `org_id IS NOT NULL` anon policies.
//
// Claims mirror the Supabase GoTrue JWT shape so PostgREST recognises it:
//   { sub, role:'authenticated', aud:'authenticated', iat, exp,
//     app_metadata:{ org_id, source_app:'sks-field' } }
//
// Only active when ORG_JWT_ENABLED=on; returns null when dark so callers can
// fall back gracefully to the existing anon path without breaking anything.
function mintOrgJwt(orgSlug) {
  if (!ORG_JWT_ENABLED || !NSPBMIR_JWT_SECRET) return null;
  const orgId = ORG_IDS[orgSlug];
  if (!orgId) return null;
  const now  = Math.floor(Date.now() / 1000);
  const exp  = now + (15 * 60); // 15-min TTL — short enough to limit blast radius
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub:          'sks-field:' + orgSlug,
    role:         'authenticated',
    aud:          'authenticated',
    iat:          now,
    exp,
    app_metadata: { org_id: orgId, source_app: 'sks-field' },
  })).toString('base64url');
  const sigInput = header + '.' + payload;
  const sig = crypto
    .createHmac('sha256', NSPBMIR_JWT_SECRET)
    .update(sigInput)
    .digest('base64url');
  return { token: sigInput + '.' + sig, exp_ms: exp * 1000, org_id: orgId };
}

// ── Handler ────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  if (!SECRET_SALT) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured — missing EQ_SECRET_SALT' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';

    // ── Token verification action ────────────────────────────
    if (body.action === 'verify-token') {
      const data = verifyToken(body.token);
      if (data) {
        const extra = (data.canonical_id || data.phone) ? { canonical_id: data.canonical_id || null, phone: data.phone || null } : null;
        const sessionToken = signToken(data.name, data.role, Date.now() + (7 * 24 * 60 * 60 * 1000), extra);
        return { statusCode: 200, headers, body: JSON.stringify({ valid: true, name: data.name, role: data.role, canonical_id: data.canonical_id || null, phone: data.phone || null, sessionToken }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false }) };
    }

    // ── Org-JWT minter (Stage-1 nspbmir lockdown — dark until ORG_JWT_ENABLED=on)
    // Client calls this after a successful PIN/shell login to obtain a short-lived
    // Supabase JWT for the nspbmir data plane. Returns { enabled: false } when dark
    // so callers can degrade gracefully to the anon path without any error.
    if (body.action === 'mint-org-jwt') {
      if (!ORG_JWT_ENABLED) {
        // Dark mode — feature not yet active. Client falls back to anon SB_KEY.
        return { statusCode: 200, headers, body: JSON.stringify({ enabled: false }) };
      }
      if (!NSPBMIR_JWT_SECRET) {
        console.error('FATAL: ORG_JWT_ENABLED=on but NSPBMIR_JWT_SECRET is not set');
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured — missing NSPBMIR_JWT_SECRET' }) };
      }
      // Require a valid session token — caller must already be past the PIN/shell gate.
      const session = verifyToken(body.sessionToken);
      if (!session) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'invalid_session' }) };
      }
      // org_id is resolved SERVER-SIDE from the fixed slug — never trust client input.
      const minted = mintOrgJwt('sks');
      if (!minted) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'mint_failed', detail: 'org slug not found in ORG_IDS_JSON' }) };
      }
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          enabled:       true,
          valid:         true,
          supabase_jwt:  minted.token,
          exp:           minted.exp_ms, // ms timestamp; client re-mints 60s before this
          org_id:        minted.org_id,
        }),
      };
    }

    // ── EQ Shell iframe handoff ──────────────────────────────
    if (body.action === 'verify-shell-token') {
      const data = verifyShellToken(body.token);
      if (data) {
        const detail = 'shell-token' + (data.tenant_slug ? (':' + data.tenant_slug) : '');
        await logAttempt(data.name, true, ip, detail);
        // canonical_user_id (eq-canonical shell_control.users.id) is the
        // deterministic join key into Field's people.canonical_id. Pass it
        // through and persist it in the session token so a reload re-resolves
        // the same person without another Shell handoff. Absent on legacy
        // tokens — the client just falls back to name-based resolution.
        const canonicalId = data.canonical_user_id || data.canonical_id || null;
        // phone is the fallback join key for workers who have a canonical
        // identity but no people.canonical_id yet (invite-only / pre-claim).
        const canonicalPhone = data.phone || null;
        const extra = (canonicalId || canonicalPhone) ? { canonical_id: canonicalId, phone: canonicalPhone } : null;
        const sessionToken = signToken(data.name, data.role, Date.now() + (7 * 24 * 60 * 60 * 1000), extra);
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ valid: true, name: data.name, role: data.role, tenant_slug: data.tenant_slug || null, canonical_id: canonicalId, phone: canonicalPhone, sessionToken })
        };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false }) };
    }

    // ── PIN verification ─────────────────────────────────────
    const { code, name, remember } = body;
    const now = Date.now();

    if (!attempts[ip]) attempts[ip] = { count: 0, lockedUntil: 0 };
    const record = attempts[ip];

    if (record.lockedUntil > now) {
      const remainingSec = Math.ceil((record.lockedUntil - now) / 1000);
      await logAttempt(name, false, ip, 'LOCKED');
      return {
        statusCode: 429, headers,
        body: JSON.stringify({ valid: false, role: null, locked: true, message: `Too many attempts. Try again in ${Math.ceil(remainingSec / 60)} minutes.` })
      };
    }

    if (!code) return { statusCode: 400, headers, body: JSON.stringify({ valid: false, role: null }) };

    if (!STAFF_CODE || !MANAGER_CODE) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured — missing STAFF_CODE or MANAGER_CODE' }) };
    }

    let role = null;
    if (code === STAFF_CODE) role = 'staff';
    else if (code === MANAGER_CODE) role = 'supervisor';

    if (role) {
      record.count = 0;
      record.lockedUntil = 0;
      await logAttempt(name, true, ip);

      let token = null;
      if (remember) {
        token = signToken(name, role, now + (7 * 24 * 60 * 60 * 1000));
      }

      const sessionToken = signToken(name, role, now + (7 * 24 * 60 * 60 * 1000));

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ valid: true, role, token, sessionToken })
      };
    } else {
      record.count++;
      if (record.count >= MAX_ATTEMPTS) {
        record.lockedUntil = now + LOCKOUT_MS;
        record.count = 0;
        await logAttempt(name, false, ip, 'LOCKOUT TRIGGERED');
        return {
          statusCode: 429, headers,
          body: JSON.stringify({ valid: false, role: null, locked: true, message: `Account locked after ${MAX_ATTEMPTS} failed attempts. Try again in 15 minutes.` })
        };
      }
      await logAttempt(name, false, ip);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ valid: false, role: null, attemptsRemaining: MAX_ATTEMPTS - record.count })
      };
    }
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
