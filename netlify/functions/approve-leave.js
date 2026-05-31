// ─────────────────────────────────────────────────────────────
// netlify/functions/approve-leave.js
// Magic-link endpoint: a supervisor clicks Approve/Reject in
// their email, lands here, and the token in the URL is the auth.
//
// The token IS the authentication — there is no login at this
// endpoint. Tokens are signed with EQ_SECRET_SALT, are bound to
// a single leave_id + action + approver email, and expire after
// 7 days. The endpoint is idempotent: clicking the same link
// twice shows an "already actioned" page on the second click,
// not a double-process.
//
// Env vars required:
//   EQ_SECRET_SALT     — HMAC signing key (must match send-email
//                        and supervisor-digest)
//   LEAVE_SB_URL       — Supabase REST URL (for leave_requests,
//                        managers, audit_log)
//   LEAVE_SB_KEY       — Supabase publishable key
//   RESEND_API_KEY     — for the requester notification
//   EMAIL_FROM         — from-address (optional, has fallback)
//   APP_ORIGIN         — used in the confirmation HTML "Open app"
//                        link (optional, defaults to the request
//                        host)
// ─────────────────────────────────────────────────────────────

const crypto = require('crypto');

const SECRET_SALT = process.env.EQ_SECRET_SALT;
const SB_URL      = process.env.LEAVE_SB_URL;
const SB_KEY      = process.env.LEAVE_SB_KEY;

if (!SECRET_SALT) console.error('FATAL: EQ_SECRET_SALT env var not set');
if (!SB_URL || !SB_KEY) console.error('FATAL: LEAVE_SB_URL or LEAVE_SB_KEY not set');

// ── Token verification ───────────────────────────────────────
// Same wire format as verify-pin's session token:
//   base64(JSON payload) + '.' + hex(HMAC-SHA256)
// Payload: { kind: 'leave-action', leave_id, action, approver_email, exp }
function verifyToken(token) {
  try {
    const [payloadB64, sig] = (token || '').split('.');
    if (!payloadB64 || !sig) return null;
    const payload = Buffer.from(payloadB64, 'base64').toString();
    const expectedSig = crypto.createHmac('sha256', SECRET_SALT).update(payload).digest('hex');
    // Constant-time compare to avoid leaking timing on the HMAC.
    if (sig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const data = JSON.parse(payload);
    if (data.kind !== 'leave-action') return null;
    if (!data.leave_id || !data.action || !data.approver_email) return null;
    if (data.action !== 'approve' && data.action !== 'reject') return null;
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (e) { return null; }
}

// ── HTML helpers ─────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtPrettyDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return iso;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${mons[d.getUTCMonth()]}`;
}

function renderPage(opts) {
  // opts: { title, headline, body, accent, appOrigin }
  const accent = opts.accent || '#1F335C';
  const appOrigin = opts.appOrigin || '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(opts.title)} — EQ Solves Field</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F9FAFB;margin:0;padding:24px;color:#1A1A2E}
  .card{max-width:520px;margin:40px auto;background:white;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden}
  .head{background:${accent};color:white;padding:20px 24px}
  .head h1{margin:0;font-size:18px;font-weight:700}
  .head p{margin:4px 0 0;font-size:13px;opacity:.7}
  .body{padding:22px 24px;font-size:14px;color:#374151;line-height:1.5}
  .body p{margin:0 0 12px}
  .body strong{color:#1F335C}
  .meta{background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;margin:16px 0;font-size:13px}
  .meta div{padding:3px 0}
  .meta .lbl{color:#6B7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  .btn{display:inline-block;background:#1F335C;color:white;padding:10px 22px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;margin-top:8px}
  .btn-confirm{display:inline-block;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;border:none;color:white;margin-top:4px}
  .foot{padding:14px;text-align:center;font-size:11px;color:#9CA3AF}
</style></head><body>
<div class="card">
  <div class="head"><h1>${escHtml(opts.headline)}</h1><p>EQ Solves — Field</p></div>
  <div class="body">${opts.body}${appOrigin ? `<div><a class="btn" href="${escHtml(appOrigin)}">Open the app</a></div>` : ''}</div>
</div>
<div class="foot">If you didn't expect this page, the link may have been forwarded — open the app to see request status.</div>
</body></html>`;
}

// ── Supabase REST helpers ────────────────────────────────────
async function sb(path, method, body, prefer) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
  };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ── Email notification (status update to requester) ─────────
const TYPE_LABELS = { 'A/L': 'Annual Leave', 'U/L': 'Unpaid Leave', 'RDO': 'RDO' };

async function sendStatusEmail(req, statusWord, respondedBy) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, detail: 'RESEND_API_KEY not set' };

  // Look up the requester's email from people OR managers (supervisors
  // can submit leave too).
  const peopleRes = await sb(`people?name=eq.${encodeURIComponent(req.requester_name)}&select=email`, 'GET');
  let toEmail = (peopleRes.ok && peopleRes.data && peopleRes.data[0] && peopleRes.data[0].email) || null;
  if (!toEmail) {
    const mgrsRes = await sb(`managers?name=eq.${encodeURIComponent(req.requester_name)}&select=email`, 'GET');
    toEmail = (mgrsRes.ok && mgrsRes.data && mgrsRes.data[0] && mgrsRes.data[0].email) || null;
  }
  if (!toEmail) return { ok: false, detail: 'no email on file for requester' };

  const typeLabel = TYPE_LABELS[req.leave_type] || req.leave_type;
  const statusColor = statusWord === 'Approved' ? '#16A34A' : '#DC2626';
  const subject = `Leave ${statusWord}: ${typeLabel} (${req.date_start} to ${req.date_end})`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:500px;margin:0 auto">
    <div style="background:#1F335C;padding:20px 24px;border-radius:12px 12px 0 0">
      <h2 style="color:white;margin:0;font-size:18px">Leave ${escHtml(statusWord)}</h2>
      <p style="color:rgba(255,255,255,.6);margin:4px 0 0;font-size:13px">EQ Solves — Field</p>
    </div>
    <div style="background:white;padding:24px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px">
      <p style="margin:0 0 16px;font-size:14px;color:#374151">Your leave request has been <strong style="color:${statusColor}">${escHtml(statusWord.toLowerCase())}</strong> by ${escHtml(respondedBy)}.</p>
      <table style="width:100%;font-size:13px;color:#374151;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#6B7280;width:100px">Type</td><td style="padding:8px 0;font-weight:600">${escHtml(typeLabel)}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280">Dates</td><td style="padding:8px 0;font-weight:600">${escHtml(req.date_start)} to ${escHtml(req.date_end)}</td></tr>
      </table>
    </div>
  </div>`;

  const fromAddr = process.env.EMAIL_FROM || 'Leave Request <noreply@eq.solutions>';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ from: fromAddr, to: [toEmail], subject, html }),
  });
  const text = await resp.text();
  return { ok: resp.ok, detail: text.slice(0, 300) };
}

// ── Shared: validate token + fetch leave row + check approver ──
// Returns { error, appOrigin } on failure (caller renders the error page),
// or { req, data, typeLabel, datesStr, appOrigin } on success.
async function resolveRequest(token, appOrigin) {
  const data = verifyToken(token);
  if (!data) return { error: 'expired', appOrigin };

  const lvRes = await sb(`leave_requests?id=eq.${encodeURIComponent(data.leave_id)}&select=*`, 'GET');
  if (!lvRes.ok || !Array.isArray(lvRes.data) || !lvRes.data.length) return { error: 'not_found', appOrigin };
  const req = lvRes.data[0];

  const mgrRes = await sb(`managers?name=eq.${encodeURIComponent(req.approver_name)}&select=name,email`, 'GET');
  const mgr = (mgrRes.ok && Array.isArray(mgrRes.data) && mgrRes.data[0]) || null;
  if (!mgr || !mgr.email || mgr.email.toLowerCase() !== String(data.approver_email).toLowerCase()) {
    return { error: 'approver_changed', appOrigin };
  }

  if (req.requester_name === req.approver_name) return { error: 'self_approve', appOrigin };

  const typeLabel = TYPE_LABELS[req.leave_type] || req.leave_type;
  const datesStr = `${fmtPrettyDate(req.date_start)} → ${fmtPrettyDate(req.date_end)}`;
  return { req, data, typeLabel, datesStr, appOrigin };
}

function renderError(error, appOrigin) {
  if (error === 'expired') return renderPage({
    title: 'Link expired', headline: 'This link has expired', accent: '#D97706', appOrigin,
    body: '<p>The approve/reject link in your email is no longer valid (expired or already used elsewhere). Open the app to action this request.</p>'
  });
  if (error === 'not_found') return renderPage({
    title: 'Request not found', headline: 'Request not found', accent: '#DC2626', appOrigin,
    body: '<p>The leave request this link refers to no longer exists.</p>'
  });
  if (error === 'approver_changed') return renderPage({
    title: 'Link no longer valid', headline: 'This link is no longer valid', accent: '#DC2626', appOrigin,
    body: '<p>The approver on this request has changed since the link was sent. Open the app to action it.</p>'
  });
  if (error === 'self_approve') return renderPage({
    title: 'Cannot self-approve', headline: 'You can\'t approve your own request', accent: '#DC2626', appOrigin,
    body: '<p>This request lists you as both the requester and the approver. Ask another supervisor to action it via the app.</p>'
  });
  return renderPage({ title: 'Error', headline: 'Something went wrong', accent: '#DC2626', appOrigin,
    body: '<p>An unexpected error occurred. Open the app to action this request.</p>'
  });
}

// ── Handler ──────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };

  // Build appOrigin from the request host so the "Open the app" link
  // works for both eq-solves-field and sks-nsw-labour deploys.
  const reqHost = event.headers['host'] || event.headers['Host'] || '';
  const appOrigin = process.env.APP_ORIGIN
    || (reqHost ? `https://${reqHost.replace(/^https?:\/\//, '')}` : '');

  if (!SECRET_SALT || !SB_URL || !SB_KEY) {
    return { statusCode: 500, headers, body: renderPage({
      title: 'Server misconfigured', headline: 'Something went wrong', accent: '#DC2626', appOrigin,
      body: '<p>Server is missing configuration. Open the app to action this request manually.</p>'
    })};
  }

  // ── GET: show confirmation page — DO NOT apply the action ────
  // Email security scanners (Gmail, Outlook SafeLinks, etc.) follow
  // every <a href> in an email body via GET before the recipient opens
  // it. If we acted on GET, the scanner would approve or reject the
  // request before the supervisor even sees it. By rendering only a
  // confirmation form on GET, scanner visits are harmless — the actual
  // PATCH only fires when the supervisor submits the form (POST).
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const token = params.t || params.token || '';
    const resolved = await resolveRequest(token, appOrigin);
    if (resolved.error) {
      return { statusCode: 200, headers, body: renderError(resolved.error, appOrigin) };
    }
    const { req, data, typeLabel, datesStr } = resolved;

    if (req.status && req.status !== 'Pending') {
      const respondedAt = req.responded_at
        ? new Date(req.responded_at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
        : '—';
      return { statusCode: 200, headers, body: renderPage({
        title: 'Already actioned', headline: 'Already actioned', accent: '#6B7280', appOrigin,
        body: `<p>This request was already actioned. No change was made.</p>
          <div class="meta">
            <div><span class="lbl">Requester</span><br>${escHtml(req.requester_name)}</div>
            <div><span class="lbl">Type</span><br>${escHtml(typeLabel)}</div>
            <div><span class="lbl">Dates</span><br>${escHtml(datesStr)}</div>
            <div><span class="lbl">Current status</span><br><strong>${escHtml(req.status)}</strong> by ${escHtml(req.responded_by || '—')} · ${escHtml(respondedAt)}</div>
          </div>`
      })};
    }

    const isApprove = data.action === 'approve';
    const confirmAccent = isApprove ? '#16A34A' : '#DC2626';
    const confirmLabel  = isApprove ? 'Approve leave' : 'Reject leave';
    const confirmBody   = isApprove
      ? `<p>You're about to <strong style="color:#16A34A">approve</strong> this leave request. Please confirm.</p>`
      : `<p>You're about to <strong style="color:#DC2626">reject</strong> this leave request. Please confirm.</p>`;
    const selfUrl = `${appOrigin}/.netlify/functions/approve-leave`;
    return { statusCode: 200, headers, body: renderPage({
      title: confirmLabel, headline: confirmLabel, accent: confirmAccent, appOrigin: '',
      body: `${confirmBody}
        <div class="meta">
          <div><span class="lbl">Requester</span><br>${escHtml(req.requester_name)}</div>
          <div><span class="lbl">Type</span><br>${escHtml(typeLabel)}</div>
          <div><span class="lbl">Dates</span><br>${escHtml(datesStr)}</div>
        </div>
        <form method="POST" action="${escHtml(selfUrl)}">
          <input type="hidden" name="t" value="${escHtml(token)}">
          <button type="submit" class="btn-confirm" style="background:${confirmAccent}">${escHtml(confirmLabel)}</button>
        </form>
        ${appOrigin ? `<div style="margin-top:16px"><a class="btn" style="background:#6B7280" href="${escHtml(appOrigin)}">Cancel — open the app</a></div>` : ''}`
    })};
  }

  // ── POST: supervisor confirmed — apply the action ────────────
  if (event.httpMethod === 'POST') {
    // Parse application/x-www-form-urlencoded body.
    let token = '';
    try {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64').toString()
        : (event.body || '');
      const parts = new URLSearchParams(body);
      token = parts.get('t') || '';
    } catch (e) { /* leave token empty — verifyToken will reject */ }

    const resolved = await resolveRequest(token, appOrigin);
    if (resolved.error) {
      return { statusCode: 200, headers, body: renderError(resolved.error, appOrigin) };
    }
    const { req, data, typeLabel, datesStr } = resolved;

    // Idempotency: if not Pending, render "already actioned".
    if (req.status && req.status !== 'Pending') {
      const respondedAt = req.responded_at
        ? new Date(req.responded_at).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
        : '—';
      return { statusCode: 200, headers, body: renderPage({
        title: 'Already actioned', headline: 'Already actioned', accent: '#6B7280', appOrigin,
        body: `<p>This request was already actioned. No change was made.</p>
          <div class="meta">
            <div><span class="lbl">Requester</span><br>${escHtml(req.requester_name)}</div>
            <div><span class="lbl">Type</span><br>${escHtml(typeLabel)}</div>
            <div><span class="lbl">Dates</span><br>${escHtml(datesStr)}</div>
            <div><span class="lbl">Current status</span><br><strong>${escHtml(req.status)}</strong> by ${escHtml(req.responded_by || '—')} · ${escHtml(respondedAt)}</div>
          </div>`
      })};
    }

    const newStatus = data.action === 'approve' ? 'Approved' : 'Rejected';
    const respondedAtISO = new Date().toISOString();
    // The magic-link path doesn't collect a free-text reason.
    // Set a marker so it's clear in the UI which path was used.
    const responseNote = newStatus === 'Rejected' ? 'Rejected via email link' : null;

    const patchRes = await sb(`leave_requests?id=eq.${encodeURIComponent(req.id)}&status=eq.Pending`, 'PATCH', {
      status: newStatus,
      response_note: responseNote,
      responded_by: req.approver_name,
      responded_at: respondedAtISO,
    }, 'return=representation');

    // The status=eq.Pending filter is a compare-and-swap:
    // if a parallel submission already flipped it, [] comes back.
    if (!patchRes.ok || !Array.isArray(patchRes.data) || !patchRes.data.length) {
      const fresh = await sb(`leave_requests?id=eq.${encodeURIComponent(req.id)}&select=*`, 'GET');
      const cur = (fresh.ok && Array.isArray(fresh.data) && fresh.data[0]) || req;
      return { statusCode: 200, headers, body: renderPage({
        title: 'Already actioned', headline: 'Already actioned', accent: '#6B7280', appOrigin,
        body: `<p>This request was actioned by another submission moments ago. No change was made.</p>
          <div class="meta">
            <div><span class="lbl">Current status</span><br><strong>${escHtml(cur.status || '—')}</strong></div>
          </div>`
      })};
    }

    // Audit log — fire-and-forget.
    sb('audit_log', 'POST', {
      manager_name: req.approver_name,
      action:       `Leave ${newStatus} via email link`,
      category:     'Leave',
      detail:       `${req.requester_name} ${typeLabel} ${req.date_start} to ${req.date_end}`,
      week:         null,
      org_id:       req.org_id || null,
    }, 'return=minimal').catch(() => {});

    // Notify requester — fire-and-forget.
    sendStatusEmail(req, newStatus, req.approver_name).catch((e) => {
      console.error('approve-leave: status email failed', e && e.message);
    });

    const accent = newStatus === 'Approved' ? '#16A34A' : '#DC2626';
    return { statusCode: 200, headers, body: renderPage({
      title: `${newStatus}`, headline: `Leave ${newStatus.toLowerCase()}`, accent, appOrigin,
      body: `<p><strong>${escHtml(req.requester_name)}</strong>'s leave request has been <strong style="color:${accent}">${escHtml(newStatus.toLowerCase())}</strong>. They'll be notified by email.</p>
        <div class="meta">
          <div><span class="lbl">Type</span><br>${escHtml(typeLabel)}</div>
          <div><span class="lbl">Dates</span><br>${escHtml(datesStr)}</div>
          <div><span class="lbl">Actioned by</span><br>${escHtml(req.approver_name)}</div>
        </div>`
    })};
  }

  return { statusCode: 405, headers, body: renderPage({
    title: 'Not allowed', headline: 'Not allowed', accent: '#DC2626', appOrigin,
    body: '<p>This endpoint only responds to GET and POST requests.</p>'
  })};
};
