// ─────────────────────────────────────────────────────────────
// netlify/functions/eq-agent.js
// Proxies chat requests to Anthropic so the API key never
// touches the browser. Auth is piggy-backed on the existing
// verify-pin HMAC token — only logged-in users can call it.
// Env vars required:
//   ANTHROPIC_API_KEY   — your sk-ant-… key
//   EQ_SECRET_SALT      — HMAC signing key (must match verify-pin)
//   AUDIT_SB_URL        — Supabase REST URL (optional, for logging)
//   AUDIT_SB_KEY        — Supabase key (optional, for logging)
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

// ── Config from env vars (no fallbacks) ──────────────────────
const SECRET_SALT = process.env.EQ_SECRET_SALT;
const SB_URL      = process.env.AUDIT_SB_URL;
const SB_KEY      = process.env.AUDIT_SB_KEY;

if (!SECRET_SALT) console.error('FATAL: EQ_SECRET_SALT env var not set');

// Default model — easy to swap via EQ_AGENT_MODEL env var.
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS    = 512;

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

// ── Per-IP rate limit (cold-start memory only, best-effort) ──
const rateBuckets = {};
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX       = 20;   // 20 calls / minute / IP

function verifyToken(token) {
  try {
    const [payloadB64, sig] = (token || '').split('.');
    if (!payloadB64 || !sig) return null;
    const payload = Buffer.from(payloadB64, 'base64').toString();
    const expectedSig = crypto.createHmac('sha256', SECRET_SALT).update(payload).digest('hex');
    // Constant-time compare — match verify-pin.js / approve-leave.js so an
    // attacker can't deduce expectedSig byte-by-byte via response timing.
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const data = JSON.parse(payload);
    if (data.exp < Date.now()) return null;
    return data;
  } catch (e) { return null; }
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = rateBuckets[ip] || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + RATE_WINDOW_MS; }
  rec.count++;
  rateBuckets[ip] = rec;
  return rec.count > RATE_MAX;
}

// ── Audit logging (non-blocking) ─────────────────────────────
async function logAgentCall(userName, ip, messageCount, model) {
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
        action: 'EQ Agent call',
        category: 'Agent',
        detail: `User: ${userName}, IP: ${ip}, Messages: ${messageCount}, Model: ${model}`,
        who: userName
      })
    });
  } catch (e) { /* non-blocking */ }
}

// ── Handler ──────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: 'Method not allowed' };

  if (!SECRET_SALT) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured — missing EQ_SECRET_SALT' }) };
  }

  try {
    // ── Auth: signed session token from verify-pin ────────────
    const token = event.headers['x-eq-token'] || event.headers['X-Eq-Token'];
    const user  = verifyToken(token);
    if (!user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated — please log in again.' }) };
    }

    // ── Rate limit ────────────────────────────────────────────
    const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    if (rateLimited(ip)) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests — slow down a little.' }) };
    }

    // ── Parse body ────────────────────────────────────────────
    const body = JSON.parse(event.body || '{}');
    const system   = typeof body.system === 'string' ? body.system.slice(0, 2000) : '';
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No messages supplied' }) };
    }

    // Defensive: clip to last 20 messages so we can't be forced
    // to send an unbounded context from a tampered client.
    const trimmed = messages.slice(-20);

    // ── Forward to Anthropic ──────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server missing ANTHROPIC_API_KEY' }) };
    }
    const model = process.env.EQ_AGENT_MODEL || DEFAULT_MODEL;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: trimmed
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) || ('Anthropic API error ' + resp.status);
      return { statusCode: 502, headers, body: JSON.stringify({ error: msg }) };
    }

    const reply = (data.content && data.content[0] && data.content[0].text) || '(no response)';

    // ── Audit log (non-blocking — don't await) ────────────────
    logAgentCall(user.name, ip, trimmed.length, model);

    return {
      statusCode: 200,
      headers:    { ...headers, 'Content-Type': 'application/json' },
      body:       JSON.stringify({ reply, model, who: user.name })
    };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
