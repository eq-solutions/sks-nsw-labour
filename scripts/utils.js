/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/utils.js  —  EQ Solves Field
// XSS sanitisation, toast, modal, CSV helpers, format helpers.
// Depends on: app-state.js
// ─────────────────────────────────────────────────────────────

// ── AbortController polyfill for iOS Safari < 16.4 ───────────
// AbortSignal.timeout() is unsupported on iOS Safari < 16.4 and
// throws TypeError when called. This helper returns an AbortSignal
// that fires after `ms` milliseconds, using native timeout() when
// available and a manual AbortController fallback otherwise.
// Added v3.4.4 (T1).
function _abortAfter(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch (e) { /* fall through to manual path */ }
  const ctrl = new AbortController();
  setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, ms);
  return ctrl.signal;
}

// ── XSS prevention ────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escHtml(str) {
  // Alias used in email templates (scripts/leave.js)
  return esc(str);
}

// ── Avatar initials ───────────────────────────────────────────
function avatarInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name[0].toUpperCase();
}

// ── Toast ─────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ── Modal ─────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// Close modal on backdrop click. modal-gate-move / modal-ts-move are
// deliberate "click OK to continue" gates (v3.10.114) — exempt them so a
// stray click outside the box can't silently dismiss them.
document.addEventListener('click', function(e) {
  if (!e.target.classList.contains('modal-overlay')) return;
  if (e.target.id === 'modal-gate-move' || e.target.id === 'modal-ts-move') return;
  e.target.classList.remove('open');
});

// ── CSV helpers ───────────────────────────────────────────────
function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvPhone(phone) {
  if (!phone) return '';
  // Wrap in quotes to preserve leading zero in Excel
  return '"' + String(phone).replace(/"/g, '""') + '"';
}

function cleanPhone(val) {
  if (!val) return '';
  return String(val).replace(/[^\d+]/g, '').replace(/^0*(\d)/, '0$1');
}

function toCSV(rows) {
  return rows.map(r => r.map(c => {
    const s = String(c == null ? '' : c);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }).join(',')).join('\n');
}

// ── Week formatting ───────────────────────────────────────────
function formatWeekLabel(week) {
  if (!week) return '—';
  const [dd, mm, yy] = week.split('.');
  if (!dd) return week;
  const date  = new Date(`20${yy}-${mm}-${dd}`);
  const day   = date.getDate();
  const suffix = day === 1 || day === 21 || day === 31 ? 'st'
    : day === 2 || day === 22 ? 'nd'
    : day === 3 || day === 23 ? 'rd' : 'th';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `Week Starting ${day}${suffix} ${months[date.getMonth()]} 20${yy}`;
}

function getWeekDates(week) {
  if (!week) return ['','','','','','',''];
  const [dd, mm, yy] = week.split('.');
  const mon = new Date(`20${yy}-${mm}-${dd}`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
  });
}