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
    if (body.action === 'verify-shell-token') {
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
