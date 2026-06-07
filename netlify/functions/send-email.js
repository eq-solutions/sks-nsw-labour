// ─────────────────────────────────────────────────────────────
// netlify/functions/send-email.js
// Sends emails via Resend API. Authenticated — requires a valid
// x-eq-token header (same HMAC session token from verify-pin).
//
// Magic-link mode (v3.4.63 — leaveActionContext):
//   Pass { leaveActionContext: { leave_id } } and use the
//   placeholders {{APPROVE_URL}} and {{REJECT_URL}} in the html
//   body. The function fetches the leave row + named approver,
//   mints two HMAC-signed tokens (kind: 'leave-action'),
//   substitutes the placeholders with full URLs to
//   /.netlify/functions/approve-leave, AND overrides `to:` with
//   the canonical approver email — so a malicious caller can't
//   redirect the magic link to their own inbox.
//
// Env vars required:
//   RESEND_API_KEY   — Resend API key
//   EQ_SECRET_SALT   — HMAC signing key (verify-pin + approve-leave)
//   LEAVE_SB_URL     — Supabase REST URL (only for magic-link mode)
//   LEAVE_SB_KEY     — Supabase publishable key (only magic-link mode)
//   APP_ORIGIN       — origin used to build magic-link URLs
//                      (optional; falls back to request Origin header)
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

// ── Config from env vars (no fallbacks) ──────────────────────
const SECRET_SALT = process.env.EQ_SECRET_SALT;
const SB_URL      = process.env.LEAVE_SB_URL;
const SB_KEY      = process.env.LEAVE_SB_KEY;

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

// ── Token verification ───────────────────────────────────────
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

// ── Input validation helpers ─────────────────────────────────
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TO      = 10;
const MAX_CC      = 10;
const MAX_SUBJECT = 200;
const MAX_HTML    = 50000;  // 50 KB

function validateEmails(arr, fieldName, max) {
  if (!Array.isArray(arr)) return `${fieldName} must be an array`;
  if (arr.length > max) return `${fieldName} exceeds maximum of ${max} recipients`;
  for (const e of arr) {
    if (typeof e !== 'string' || !EMAIL_RE.test(e)) return `Invalid email in ${fieldName}: ${String(e).slice(0, 50)}`;
  }
  return null;
}

// ── Magic-link minting (v3.4.63 — leaveActionContext) ────────
// Sign a token of shape { kind, leave_id, action, approver_email, exp }.
// Tokens are minted server-side ONLY — the requester's browser never
// sees them, which is what stops a requester from minting their own
// approve-link to bypass the named approver.
//
// v3.10.45: TTL is defined here (the minting side) and baked into the
// token's `exp` field. approve-leave.js reads `exp` from the token
// directly — it has no TTL constant of its own. Only change it here.
const LEAVE_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — source of truth

function signLeaveActionToken(leaveId, action, approverEmail) {
  const payload = JSON.stringify({
    kind: 'leave-action',
    leave_id: leaveId,
    action,                                // 'approve' | 'reject'
    approver_email: approverEmail,
    exp: Date.now() + LEAVE_ACTION_TTL_MS,
  });
  const sig = crypto.createHmac('sha256', SECRET_SALT).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}

async function sbGet(path) {
  const headers = { 'Content-Type': 'application/json', 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` };
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { method: 'GET', headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* malformed, leave null */ }
  return { ok: res.ok, status: res.status, data };
}

// Resolve approver name → email and return both, alongside a basic
// validity check. Returns null when the request is malformed or the
// approver can't be looked up — the caller falls back to plain HTML
// (no buttons) rather than failing the whole email.
async function resolveLeaveActionContext(leaveId) {
  if (!SB_URL || !SB_KEY) return { error: 'Magic-link mode requires LEAVE_SB_URL and LEAVE_SB_KEY' };
  // v3.4.65: accept both string (uuid) and number (bigint) ids. SKS
  // leave_requests.id is bigint (returned as JSON number); EQ is uuid
  // string. The strict typeof === 'string' check silently dropped every
  // SKS leave-request email's magic-link substitution → placeholders
  // stayed as literal {{APPROVE_URL}} / {{REJECT_URL}} text in the email
  // href, which email clients rendered as render://# (Outlook quirk for
  // invalid schemes). Same id-coercion bug class as BATTLE-TEST #22, #27.
  const idStr = (leaveId === null || leaveId === undefined) ? '' : String(leaveId);
  if (!idStr) return { error: 'leave_id required' };
  // v3.10.44: fetch org_id alongside name fields so the manager lookup
  // can be scoped to the same org (prevents cross-tenant name collisions).
  const lvRes = await sbGet(`leave_requests?id=eq.${encodeURIComponent(idStr)}&select=id,requester_name,approver_name,status,org_id`);
  if (!lvRes.ok || !Array.isArray(lvRes.data) || !lvRes.data.length) return { error: 'leave row not found' };
  const lv = lvRes.data[0];
  if (lv.status && lv.status !== 'Pending') return { error: 'leave already actioned' };
  // v3.10.44: scope manager lookup by org_id so same-name managers across
  // different tenants don't cross-resolve to each other's email.
  const orgFilter = lv.org_id ? `&org_id=eq.${encodeURIComponent(lv.org_id)}` : '';
  const mgrRes = await sbGet(`managers?name=eq.${encodeURIComponent(lv.approver_name)}${orgFilter}&select=email`);
  const mgr = (mgrRes.ok && Array.isArray(mgrRes.data) && mgrRes.data[0]) || null;
  if (!mgr || !mgr.email) return { error: 'approver has no email on file' };
  return { leave: lv, approverEmail: String(mgr.email).toLowerCase() };
}

// ── Handler ──────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method not allowed' };

  if (!SECRET_SALT) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured — missing EQ_SECRET_SALT' }) };
  }

  try {
    // ── Auth: require valid session token ─────────────────────
    const token = event.headers['x-eq-token'] || event.headers['X-Eq-Token'];
    const user = verifyToken(token);
    if (!user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not authenticated — please log in again.' }) };
    }

    const body = JSON.parse(event.body);
    const { to, cc, subject, html, leaveActionContext } = body;

    // ── Input validation ──────────────────────────────────────
    if (!to || !subject || !html) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: to, subject, html' }) };
    }

    let toArr = Array.isArray(to) ? to : [to];
    const toErr = validateEmails(toArr, 'to', MAX_TO);
    if (toErr) return { statusCode: 400, headers, body: JSON.stringify({ error: toErr }) };

    if (cc && cc.length) {
      const ccArr = Array.isArray(cc) ? cc : [cc];
      const ccErr = validateEmails(ccArr, 'cc', MAX_CC);
      if (ccErr) return { statusCode: 400, headers, body: JSON.stringify({ error: ccErr }) };
    }

    if (typeof subject !== 'string' || subject.length > MAX_SUBJECT) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Subject must be a string under ${MAX_SUBJECT} characters` }) };
    }

    if (typeof html !== 'string' || html.length > MAX_HTML) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `HTML body exceeds maximum size of ${MAX_HTML} characters` }) };
    }

    // ── Magic-link mode: substitute {{APPROVE_URL}} / {{REJECT_URL}}
    // and override `to:` with the canonical approver email so the
    // sender can't redirect the link to their own inbox.
    let finalHtml = html;
    if (leaveActionContext && typeof leaveActionContext === 'object') {
      const ctx = await resolveLeaveActionContext(leaveActionContext.leave_id);
      if (ctx.error) {
        // Strip placeholders so the email still goes through, just
        // without buttons. Log the reason so it's debuggable from
        // the function logs without surfacing internals to callers.
        console.warn('send-email: magic-link context not resolved:', ctx.error);
        finalHtml = finalHtml.replace(/\{\{APPROVE_URL\}\}/g, '#').replace(/\{\{REJECT_URL\}\}/g, '#');
      } else {
        // Force the to-list to exactly the named approver. Defends
        // against a caller passing a different `to:` and lying about
        // the leave_id to receive a working approve link themselves.
        toArr = [ctx.approverEmail];
        const originHeader = event.headers['origin'] || event.headers['Origin'] || '';
        const appOrigin = process.env.APP_ORIGIN || originHeader || '';
        const approveTok = signLeaveActionToken(ctx.leave.id, 'approve', ctx.approverEmail);
        const rejectTok  = signLeaveActionToken(ctx.leave.id, 'reject',  ctx.approverEmail);
        const approveUrl = `${appOrigin}/.netlify/functions/approve-leave?t=${encodeURIComponent(approveTok)}`;
        const rejectUrl  = `${appOrigin}/.netlify/functions/approve-leave?t=${encodeURIComponent(rejectTok)}`;
        finalHtml = finalHtml.replace(/\{\{APPROVE_URL\}\}/g, approveUrl).replace(/\{\{REJECT_URL\}\}/g, rejectUrl);
      }
    }

    // ── Send via Resend ───────────────────────────────────────
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server missing RESEND_API_KEY' }) };
    }

    const payload = {
      from: process.env.EMAIL_FROM || 'Leave Request <noreply@eq.solutions>',
      to: toArr,
      subject,
      html: finalHtml
    };
    if (cc && cc.length) payload.cc = Array.isArray(cc) ? cc : [cc];

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers,
        body: JSON.stringify({ error: data.message || 'Email service error' })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, id: data.id })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal error' })
    };
  }
};
