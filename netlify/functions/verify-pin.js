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
const SECRET_SALT         = process.env.EQ_SECRET_SALT;
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET; // Shell-minted JWT verification (Phase 3)
const SB_URL              = process.env.AUDIT_SB_URL;
const SB_KEY              = process.env.AUDIT_SB_KEY;

if (!SECRET_SALT) console.error('FATAL: EQ_SECRET_SALT env var not set');

// ── Allowed origins for CORS ─────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://sks-nsw-labour.netlify.app',
  'https://sks-field.netlify.app',
  'https://eq-solves-field.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000',
];

function corsHeaders(event) {
  const origin = event.headers['origin'] || event.headers['Origin'] || '';
  const allowed = ALLOWED_ORIGINS.some(o =>
    origin === o ||
    origin.endsWith('--sks-nsw-labour.netlify.app') ||
    origin.endsWith('--sks-field.netlify.app') ||
    origin.endsWith('--eq-solves-field.netlify.app')
  );
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

// ── Canonical role helpers ────────────────────────────────────
const EQ_ROLE_KEYS       = ['manager', 'supervisor', 'employee', 'apprentice', 'labour_hire'];
const FIELD_DISPATCH_ROLES = new Set(['manager', 'supervisor']);

// ── Supabase JWT helpers (Phase 3 — Shell token-exchange path) ─
// token-exchange.ts mints a 3-part HS256 JWT; the 2-part HMAC shell token
// is the legacy path. Auto-detect so both work during the transition.
function isSupabaseJwt(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(
      Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
    );
    return header.alg === 'HS256' && header.typ === 'JWT';
  } catch (e) { return false; }
}

// Verifies a Shell-minted Supabase HS256 JWT against SUPABASE_JWT_SECRET.
// Returns the decoded claims on success, null on any failure.
function verifySupabaseJwt(token) {
  try {
    const secret = SUPABASE_JWT_SECRET;
    if (!secret) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const signingInput = headerB64 + '.' + payloadB64;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(signingInput)
      .digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (expectedSig.length !== sigB64.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sigB64))) return null;
    const payloadJson = Buffer.from(
      payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'
    ).toString();
    const claims = JSON.parse(payloadJson);
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch (e) { return null; }
}

// ── Token signing & verification ─────────────────────────────
function signToken(name, role, expiresAt) {
  const payload = JSON.stringify({ name, role, exp: expiresAt });
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

// ── Handler ────────────────────────────────────────���─────────
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
        const sessionToken = signToken(data.name, data.role, Date.now() + (7 * 24 * 60 * 60 * 1000));
        return { statusCode: 200, headers, body: JSON.stringify({ valid: true, name: data.name, role: data.role, sessionToken }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false }) };
    }

    // ── EQ Shell iframe handoff ──────────────────────────────
    // Phase 3: auto-detect Supabase JWT (3-part, from token-exchange) vs
    // legacy HMAC shell token (2-part, from mint-iframe-token).
    if (body.action === 'verify-shell-token') {
      if (isSupabaseJwt(body.token)) {
        const claims = verifySupabaseJwt(body.token);
        if (claims) {
          const emailClaim = (claims.app_metadata && claims.app_metadata.email) || '';
          const name = emailClaim ? emailClaim.split('@')[0] : (claims.sub || 'unknown');
          const rawRole = (claims.app_metadata && claims.app_metadata.eq_role) || 'employee';
          const eq_role = EQ_ROLE_KEYS.includes(rawRole) ? rawRole : 'employee';
          const isPlatformAdmin = !!(claims.app_metadata && claims.app_metadata.is_platform_admin);
          const role = (FIELD_DISPATCH_ROLES.has(eq_role) || isPlatformAdmin) ? 'supervisor' : 'staff';
          const sessionToken = signToken(name, role, Date.now() + (7 * 24 * 60 * 60 * 1000));
          await logAttempt(name, true, ip, 'supabase-jwt:shell');
          return {
            statusCode: 200, headers,
            body: JSON.stringify({ valid: true, name, role, eq_role, tenant_slug: null, sessionToken })
          };
        }
        return { statusCode: 200, headers, body: JSON.stringify({ valid: false }) };
      }

      const data = verifyShellToken(body.token);
      if (data) {
        const detail = 'shell-token' + (data.tenant_slug ? (':' + data.tenant_slug) : '');
        await logAttempt(data.name, true, ip, detail);
        const sessionToken = signToken(data.name, data.role, Date.now() + (7 * 24 * 60 * 60 * 1000));
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ valid: true, name: data.name, role: data.role, tenant_slug: data.tenant_slug || null, sessionToken })
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
