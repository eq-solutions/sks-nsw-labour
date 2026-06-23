/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/safety.js  —  EQ Solves Field (SKS)
// Safety module: Prestart Briefings + Toolbox Talks.
// Self-contained — photo resize, signature pad, and offline
// queue are inlined so this module ships without site-reports-
// shared.js. Designed for mobile-first, any-staff access.
// Depends on: app-state.js, utils.js, supabase.js
// ─────────────────────────────────────────────────────────────

// ── State ──────────────────────────────────────────────────────
let _prestartCache = [];
let _prestartDraft = null;
let _prestartId    = null;
const _prestartInflight = new Set();

let _toolboxCache = [];
let _toolboxDraft = null;
let _toolboxId    = null;
const _toolboxInflight = new Set();

let _safetyTab = 'prestart';
const _safetyArmed = new Set();

// ── HRCW categories (NSW WHS Regulation Schedule 3) ───────────
const HRCW = [
  { id: 'cs',     label: 'Confined space' },
  { id: 'elec',   label: 'Energised electrical' },
  { id: 'demo',   label: 'Demolition' },
  { id: 'asb',    label: 'Asbestos' },
  { id: 'h2m',    label: 'Height > 2m / fall risk' },
  { id: 'gas',    label: 'Pressurised gas' },
  { id: 'expl',   label: 'Explosives' },
  { id: 'road',   label: 'Adjacent to road / rail' },
  { id: 'water',  label: 'In or near water' },
  { id: 'tele',   label: 'Telecommunications towers' },
  { id: 'dive',   label: 'Diving work' },
  { id: 'mob',    label: 'Mobile plant' },
  { id: 'preca',  label: 'Tilt-up / precast concrete' },
  { id: 'trench', label: 'Trench / shaft / excavation > 1.5m' },
  { id: 'tunnel', label: 'Tunnels' },
  { id: 'chem',   label: 'Chemicals / fuel / refrigerant' },
  { id: 'temp',   label: 'Extreme temperature' },
  { id: 'bio',    label: 'Biological material' },
  { id: 'press',  label: 'Pressure vessels' },
];

// ── Relevant Permits (matches SKS Daily Pre-Start template) ───
const PERMITS_CATS = [
  { id: 'hot',      label: 'Hot Works' },
  { id: 'cutcore',  label: 'Cut & Core' },
  { id: 'excav',    label: 'Excavation' },
  { id: 'isol',     label: 'Isolation' },
  { id: 'energ',    label: 'Energization' },
  { id: 'asb',      label: 'Asbestos' },
  { id: 'confined', label: 'Confined / Restricted Space' },
  { id: 'harness',  label: 'Harness' },
  { id: 'roof',     label: 'Roof Access' },
  { id: 'other',    label: 'Other (please list)' },
];

// ── Shared helpers ─────────────────────────────────────────────
function _todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function _nowTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function _todayWeekKey() {
  const d = new Date(), mon = new Date(d);
  mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return String(mon.getDate()).padStart(2,'0') + '.' + String(mon.getMonth()+1).padStart(2,'0') + '.' + String(mon.getFullYear()).slice(-2);
}

function _todayDayKey() {
  return ['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()];
}

function _fmtDate(iso) {
  if (!iso) return '';
  const p = iso.split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso;
}

function _currentUser() {
  return sessionStorage.getItem('eq_logged_in_name') ||
    (typeof currentManagerName !== 'undefined' && currentManagerName) || 'Unknown';
}

function _isLocalId(id) { return id && String(id).startsWith('local_'); }

function _siteDatalist(dlId) {
  const sites = (typeof STATE !== 'undefined' && STATE.sites) || [];
  return '<datalist id="' + dlId + '">' + sites.map(function(s) {
    return '<option value="' + esc(s.abbr) + '">' + esc(s.name || s.abbr) + '</option>';
  }).join('') + '</datalist>';
}

function _peopleDatalist(id) {
  const people = (typeof STATE !== 'undefined' && STATE.people) || [];
  if (!people.length) return '';
  return '<datalist id="' + id + '">' + people.map(function(p) { return '<option value="' + esc(p.name) + '">'; }).join('') + '</datalist>';
}

const _I = 'width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px;font-family:inherit;box-sizing:border-box';
const _TA = _I + ';resize:vertical;min-height:60px';

function _lbl(text) {
  return '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-3);margin:16px 0 6px">' + text + '</div>';
}

function _fld(label, content) {
  return '<div style="margin-bottom:10px"><label style="display:block;font-size:11px;font-weight:600;color:var(--ink-2);margin-bottom:3px">' + label + '</label>' + content + '</div>';
}

function _statusPill(status) {
  return status === 'submitted'
    ? '<span style="background:#dcfce7;color:#15803d;border:1px solid #bbf7d0;border-radius:20px;padding:2px 8px;font-size:10px;font-weight:600">Submitted</span>'
    : '<span style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:20px;padding:2px 8px;font-size:10px;font-weight:600">Draft</span>';
}

// ── Photo helpers ──────────────────────────────────────────────
const _PHOTO_MAX = 8;

function _photoResize(file, cb) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      let w = img.width, h = img.height, max = 1600;
      if (w > max || h > max) { const s = Math.min(max / w, max / h); w = Math.round(w * s); h = Math.round(h * s); }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      try { cb(c.toDataURL('image/jpeg', 0.7)); } catch(err) { cb(null); }
    };
    img.onerror = function() { cb(null); };
    img.src = e.target.result;
  };
  reader.onerror = function() { cb(null); };
  reader.readAsDataURL(file);
}

function _photoAdd(draft, fileInput, onChange) {
  if (!draft || !fileInput.files || !fileInput.files[0]) return;
  if ((draft.photos || []).length >= _PHOTO_MAX) { showToast('Max ' + _PHOTO_MAX + ' photos'); return; }
  const file = fileInput.files[0];
  if (!/^image\//.test(file.type)) { showToast('Image files only'); return; }
  _photoResize(file, function(base64) {
    if (!base64) { showToast('Photo unreadable'); return; }
    if (!Array.isArray(draft.photos)) draft.photos = [];
    draft.photos.push({ id: 'p_' + Date.now(), caption: '', base64: base64, taken_at: new Date().toISOString(), taken_by: _currentUser() });
    fileInput.value = '';
    onChange();
  });
}

function _photoRemove(draft, i, onChange) {
  if (!draft || !draft.photos) return;
  draft.photos.splice(i, 1);
  onChange();
}

function _photoSetCaption(draft, i, caption) {
  if (draft && draft.photos && draft.photos[i]) draft.photos[i].caption = caption;
}

function _photoLightbox(draft, i) {
  if (!draft || !draft.photos || !draft.photos[i]) return;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;cursor:zoom-out';
  ov.onclick = function() { ov.remove(); };
  const img = document.createElement('img');
  img.src = draft.photos[i].base64;
  img.style.cssText = 'max-width:100%;max-height:90vh;object-fit:contain';
  ov.appendChild(img); document.body.appendChild(ov);
}

function _photoRenderList(draft, prefix) {
  const photos = (draft && draft.photos) || [];
  const grid = photos.map(function(p, i) {
    return '<div style="position:relative;width:80px;height:80px;border-radius:6px;overflow:hidden;border:1px solid var(--border);flex-shrink:0">'
      + '<img src="' + esc(p.base64) + '" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in" onclick="' + prefix + 'PhotoLightbox(' + i + ')">'
      + '<button onclick="' + prefix + 'PhotoRemove(' + i + ');event.stopPropagation()" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.6);color:#fff;border:none;border-radius:50%;width:18px;height:18px;cursor:pointer;font-size:10px;padding:0;line-height:1">✕</button>'
      + '</div>';
  }).join('');
  const addBtn = photos.length < _PHOTO_MAX
    ? '<label style="width:80px;height:80px;border:1px dashed var(--border);border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:10px;color:var(--ink-3);user-select:none">'
      + '<span style="font-size:20px">📷</span><span style="margin-top:2px">Add</span>'
      + '<input type="file" accept="image/*" capture="environment" onchange="' + prefix + 'PhotoAdd(this)" style="display:none"></label>'
    : '';
  const caps = photos.length
    ? '<div style="margin-top:6px;display:grid;grid-template-columns:1fr 1fr;gap:4px">'
      + photos.map(function(p, i) { return '<input type="text" placeholder="Caption ' + (i + 1) + '" value="' + esc(p.caption || '') + '" oninput="' + prefix + 'PhotoCaption(' + i + ',this.value)" style="' + _I + ';font-size:11px">'; }).join('') + '</div>'
    : '';
  return '<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start">' + grid + addBtn + '</div>' + caps;
}

// ── Signature helpers ──────────────────────────────────────────
let _sigCtx = null; // { canvas, ctx, draft, key, idx, modalId, onChange, hasInk, drawing }

function _sigOpen(draft, key, idx, modalId, onChange) {
  const list = draft && draft[key];
  if (!list || !list[idx]) return;
  if (list[idx].signed_at) { showToast('Already signed'); return; }
  const name = list[idx].name || 'Attendee';
  let modal = document.getElementById(modalId);
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = modalId;
    const jsId = modalId.replace(/-/g, '_');
    modal.innerHTML =
        '<div class="modal" style="max-width:460px;width:92vw">'
      +   '<div class="modal-header">'
      +     '<h3 id="' + modalId + '-title">Sign</h3>'
      +     '<button class="modal-close" onclick="closeModal(\'' + modalId + '\')">✕</button>'
      +   '</div>'
      +   '<div class="modal-body" style="padding:14px">'
      +     '<p style="font-size:11px;color:var(--ink-3);margin:0 0 8px">Sign with finger or mouse to confirm attendance.</p>'
      +     '<canvas id="' + modalId + '-canvas" style="width:100%;height:200px;background:#fff;border:1px solid var(--border);border-radius:8px;touch-action:none;display:block"></canvas>'
      +     '<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">'
      +       '<button class="btn btn-secondary btn-sm" onclick="' + jsId + '_clear()">Clear</button>'
      +       '<button class="btn btn-secondary btn-sm" onclick="closeModal(\'' + modalId + '\')">Cancel</button>'
      +       '<button class="btn" onclick="' + jsId + '_save()">Save signature</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(modal);
  }
  document.getElementById(modalId + '-title').textContent = 'Sign — ' + name;
  _sigCtx = { draft: draft, key: key, idx: idx, modalId: modalId, onChange: onChange, hasInk: false, drawing: false };
  openModal(modalId);
  setTimeout(_sigInit, 30);
}

function _sigInit() {
  if (!_sigCtx) return;
  const canvas = document.getElementById(_sigCtx.modalId + '-canvas');
  if (!canvas) return;
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1A1A2E';
  _sigCtx.canvas = canvas; _sigCtx.ctx = ctx;
  function pt(e) { const b = canvas.getBoundingClientRect(), t = e.touches ? e.touches[0] : e; return { x: t.clientX - b.left, y: t.clientY - b.top }; }
  function dn(e) { e.preventDefault(); _sigCtx.drawing = true; const p = pt(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function mv(e) { if (!_sigCtx.drawing) return; e.preventDefault(); const p = pt(e); ctx.lineTo(p.x, p.y); ctx.stroke(); _sigCtx.hasInk = true; }
  function up(e) { if (e) e.preventDefault(); _sigCtx.drawing = false; }
  canvas.addEventListener('mousedown', dn); canvas.addEventListener('mousemove', mv); canvas.addEventListener('mouseup', up); canvas.addEventListener('mouseleave', up);
  canvas.addEventListener('touchstart', dn, { passive: false }); canvas.addEventListener('touchmove', mv, { passive: false }); canvas.addEventListener('touchend', up, { passive: false });
}

function _sigClear() { if (_sigCtx && _sigCtx.canvas) { _sigCtx.ctx.clearRect(0, 0, _sigCtx.canvas.width, _sigCtx.canvas.height); _sigCtx.hasInk = false; } }

function _sigSave() {
  if (!_sigCtx || !_sigCtx.hasInk) { showToast('Sign first'); return; }
  const list = _sigCtx.draft[_sigCtx.key];
  if (!list || !list[_sigCtx.idx]) return;
  list[_sigCtx.idx].signature_image = _sigCtx.canvas.toDataURL('image/png');
  list[_sigCtx.idx].signed_at = new Date().toISOString();
  list[_sigCtx.idx].signed_by = _currentUser();
  const onChange = _sigCtx.onChange; const modalId = _sigCtx.modalId;
  closeModal(modalId); _sigCtx = null;
  onChange();
}

// Global shims so dynamically-created modal buttons work
function modal_prestart_sig_clear() { _sigClear(); }
function modal_prestart_sig_save()  { _sigSave(); }
function modal_toolbox_sig_clear()  { _sigClear(); }
function modal_toolbox_sig_save()   { _sigSave(); }

// ── Offline queue ──────────────────────────────────────────────
function _qRead(key) { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch(e) { return []; } }
function _qWrite(key, items) { try { localStorage.setItem(key, JSON.stringify(items || [])); } catch(e) { console.warn('EQ[safety] queue write failed:', e); } }

function _qUpdatePill(pillId, count) {
  const el = document.getElementById(pillId);
  if (!el) return;
  if (count > 0) { el.style.display = ''; el.textContent = '⏳ ' + count + ' pending offline write' + (count === 1 ? '' : 's'); }
  else el.style.display = 'none';
}

async function _qPersist(table, qKey, pillId, currentId, payload) {
  const persistId = (currentId && !_isLocalId(currentId)) ? currentId : null;
  const method = persistId ? 'PATCH' : 'POST';
  const path   = persistId ? table + '?id=eq.' + encodeURIComponent(persistId) : table;
  if (!navigator.onLine) {
    const q = _qRead(qKey);
    q.push({ qid: 'q_' + Date.now(), method: method, path: path, payload: payload, queued_at: new Date().toISOString() });
    _qWrite(qKey, q); _qUpdatePill(pillId, q.length);
    showToast('Offline — saved locally, will sync when connected');
    return { id: currentId || ('local_' + Date.now()), _offline: true };
  }
  try {
    const ret = await sbFetch(path, method, payload, 'return=representation');
    return (Array.isArray(ret) && ret[0]) ? ret[0] : (persistId ? { id: persistId } : { id: null });
  } catch(e) {
    const q = _qRead(qKey);
    q.push({ qid: 'q_' + Date.now(), method: method, path: path, payload: payload, queued_at: new Date().toISOString() });
    _qWrite(qKey, q); _qUpdatePill(pillId, q.length);
    showToast('Network hiccup — saved locally, will sync');
    return { id: currentId || ('local_' + Date.now()), _offline: true };
  }
}

async function _qReplay(qKey, pillId, onComplete) {
  if (!navigator.onLine) return;
  const queue = _qRead(qKey);
  if (!queue.length) return;
  const remaining = []; let synced = 0;
  for (const item of queue) {
    try { await sbFetch(item.path, item.method, item.payload, 'return=minimal'); synced++; }
    catch(e) { console.warn('EQ[safety] replay failed for', item.qid, e && e.message); remaining.push(item); }
  }
  _qWrite(qKey, remaining); _qUpdatePill(pillId, remaining.length);
  if (synced > 0) {
    showToast('Synced ' + synced + ' offline record' + (synced === 1 ? '' : 's'));
    if (typeof onComplete === 'function') onComplete();
  }
}

// ── Speech-to-text input ───────────────────────────────────────
let _speechRec   = null;
let _speechField = null;

function _micBtn(prefix, fkey) {
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return '';
  const fieldId = prefix + '_' + fkey;
  const active  = _speechField === fieldId;
  return '<button type="button" onclick="_speechToggle(\'' + prefix + '\',\'' + fkey + '\')" title="Voice input" '
    + 'style="flex-shrink:0;width:34px;height:34px;border:1px solid ' + (active ? 'var(--blue)' : 'var(--border)') + ';border-radius:7px;'
    + 'background:' + (active ? 'var(--blue)' : 'var(--surface)') + ';cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;padding:0">🎤</button>';
}

function _speechToggle(prefix, fkey) {
  const fieldId = prefix + '_' + fkey;
  if (_speechRec) {
    _speechRec.stop(); _speechRec = null; _speechField = null;
    try { renderPrestartForm(); } catch(e) {}
    try { renderToolboxForm();  } catch(e) {}
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Voice input not supported'); return; }
  const draft    = prefix === 'ps' ? _prestartDraft    : _toolboxDraft;
  const setter   = prefix === 'ps' ? _psField           : _tbField;
  const rerender = prefix === 'ps' ? renderPrestartForm : renderToolboxForm;
  const rec = new SR();
  rec.lang = 'en-AU'; rec.continuous = true; rec.interimResults = false;
  _speechRec = rec; _speechField = fieldId;
  rec.onresult = function(e) {
    const t = Array.from(e.results).slice(e.resultIndex)
      .filter(function(r) { return r.isFinal; })
      .map(function(r) { return r[0].transcript; }).join(' ').trim();
    if (!t || !draft) return;
    setter(fkey, (draft[fkey] || '') + ((draft[fkey] || '') ? ' ' : '') + t);
    rerender();
  };
  rec.onerror = function(ev) {
    _speechRec = null; _speechField = null; rerender();
    if (ev.error !== 'aborted') showToast('Mic error — check browser permissions');
  };
  rec.onend = function() {
    if (_speechRec === rec) { _speechRec = null; _speechField = null; rerender(); }
  };
  rec.start();
  rerender();
}

function _taWithMic(prefix, fkey, value, placeholder) {
  return '<div style="display:flex;gap:6px;align-items:flex-start">'
    + '<textarea oninput="_' + prefix + 'Field(\'' + fkey + '\',this.value)" '
    + 'placeholder="' + esc(placeholder) + '" style="' + _TA + ';flex:1;min-width:0">' + esc(value || '') + '</textarea>'
    + _micBtn(prefix, fkey)
    + '</div>';
}

// ── Roster pull ────────────────────────────────────────────────
function _rosterPullNames(siteAbbr) {
  const schedule = (typeof STATE !== 'undefined' && STATE.schedule) || [];
  const people   = (typeof STATE !== 'undefined' && STATE.people)   || [];
  const weekKey  = _todayWeekKey();
  const dayKey   = _todayDayKey();
  const results  = [];
  schedule.forEach(function(entry) {
    if (entry.week !== weekKey) return;
    if ((entry[dayKey] || '').trim().toUpperCase() !== siteAbbr.trim().toUpperCase()) return;
    const person = people.find(function(p) { return p.name === entry.name; });
    results.push({ name: entry.name, person_id: person ? (person.id || null) : null, signed_at: null, signed_by: null, signature_image: null });
  });
  return results;
}

function _psRosterPull() {
  if (!_prestartDraft || !_prestartDraft.site_abbr) { showToast('Select a site first'); return; }
  const existing = new Set((_prestartDraft.crew || []).map(function(c) { return c.name; }));
  const toAdd    = _rosterPullNames(_prestartDraft.site_abbr).filter(function(r) { return !existing.has(r.name); });
  if (!toAdd.length) { showToast('No new names on roster for this site today'); return; }
  if (!Array.isArray(_prestartDraft.crew)) _prestartDraft.crew = [];
  toAdd.forEach(function(r) { _prestartDraft.crew.push(r); });
  showToast('Added ' + toAdd.length + ' from roster');
  renderPrestartForm();
}

function _tbRosterPull() {
  if (!_toolboxDraft || !_toolboxDraft.site_abbr) { showToast('Select a site first'); return; }
  const existing = new Set((_toolboxDraft.attendance || []).map(function(a) { return a.name; }));
  const toAdd    = _rosterPullNames(_toolboxDraft.site_abbr).filter(function(r) { return !existing.has(r.name); });
  if (!toAdd.length) { showToast('No new names on roster for this site today'); return; }
  if (!Array.isArray(_toolboxDraft.attendance)) _toolboxDraft.attendance = [];
  toAdd.forEach(function(r) { _toolboxDraft.attendance.push(r); });
  showToast('Added ' + toAdd.length + ' from roster');
  renderToolboxForm();
}

// ── Inject responsive styles once ─────────────────────────────
function _injectSafetyStyle() {
  if (document.getElementById('safety-responsive-style')) return;
  const s = document.createElement('style');
  s.id = 'safety-responsive-style';
  s.textContent = '@media(max-width:640px){'
    + '#modal-prestart .modal,#modal-toolbox .modal{max-width:100vw!important;width:100vw!important;height:100vh!important;max-height:100vh!important;border-radius:0!important}'
    + '#modal-prestart-sig .modal,#modal-toolbox-sig .modal{max-width:100vw!important;width:100vw!important}'
    + '#modal-prestart-sig canvas,#modal-toolbox-sig canvas{height:260px!important}'
    + '#prestart-form-body .grid2,#toolbox-form-body .grid2{grid-template-columns:1fr!important}'
    + '}';
  document.head.appendChild(s);
}

// ════════════════════════════════════════════════════════════════
// TAB
// ════════════════════════════════════════════════════════════════

function showSafetyTab(tab) {
  _safetyTab = tab;
  ['prestart', 'toolbox'].forEach(function(t) {
    const content = document.getElementById('safety-tab-content-' + t);
    const btn     = document.getElementById('safety-tab-btn-' + t);
    if (content) content.style.display = t === tab ? '' : 'none';
    if (btn) {
      btn.style.borderBottom = t === tab ? '2px solid var(--blue)' : '2px solid transparent';
      btn.style.color        = t === tab ? 'var(--blue)' : 'var(--ink-3)';
      btn.style.fontWeight   = t === tab ? '700' : '500';
    }
  });
  if (tab === 'prestart') renderPrestart();
  else renderToolbox();
}

// ════════════════════════════════════════════════════════════════
// PRESTART
// ════════════════════════════════════════════════════════════════

const _PS_QKEY = 'sks_prestart_offline_queue_v1';
const _PS_PILL = 'prestart-offline-pill';

async function loadPrestarts() {
  try {
    const rows = await sbFetch('prestarts?select=*&order=briefing_date.desc,briefing_time.desc&limit=200');
    _prestartCache = Array.isArray(rows) ? rows : [];
  } catch(e) {
    console.warn('EQ[safety/prestart] load failed:', e && e.message || e);
    _prestartCache = [];
  }
}

function renderPrestart() {
  const el = document.getElementById('page-prestart-list');
  if (!el) return;
  _injectSafetyStyle();
  const today  = _todayIso();
  const todays = _prestartCache.filter(function(r) { return r.briefing_date === today; });
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
  const recent = _prestartCache.filter(function(r) { return r.briefing_date !== today && new Date(r.briefing_date) >= cutoff; });

  let h = '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface)">'
    + '<div><div style="font-size:13px;font-weight:700">Today — ' + _fmtDate(today) + '</div>'
    + '<div style="font-size:11px;color:var(--ink-3);margin-top:1px">' + todays.length + ' prestart' + (todays.length !== 1 ? 's' : '') + '</div></div>'
    + '<button class="btn" onclick="openPrestartForm()">＋ New</button></div>';

  h += todays.length
    ? todays.map(_prestartRow).join('')
    : '<div style="padding:12px 16px;font-size:12px;color:var(--ink-3);background:var(--surface-2);border-bottom:1px solid var(--border)">No prestarts today — tap <strong>New</strong> to start one.</div>';

  if (recent.length) {
    h += '<div style="padding:5px 16px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-3);background:var(--surface-2);border-bottom:1px solid var(--border);border-top:1px solid var(--border)">Past 7 days</div>';
    h += recent.map(_prestartRow).join('');
  }
  el.innerHTML = h;
}

function _prestartRow(r) {
  const site  = (typeof STATE !== 'undefined' && STATE.sites || []).find(function(s) { return s.abbr === r.site_abbr; });
  const sName = site ? site.name : (r.site_abbr || 'No site');
  const signed = (r.crew || []).filter(function(c) { return c.signed_at; }).length;
  const total  = (r.crew || []).length;
  const crew   = total ? '<span style="font-size:11px;color:var(--ink-3)">' + signed + '/' + total + ' signed</span>' : '';
  return '<div onclick="openPrestartForm(\'' + esc(r.id) + '\')" style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;background:var(--surface)" onmouseover="this.style.background=\'var(--surface-2)\'" onmouseout="this.style.background=\'var(--surface)\'">'
    + '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(sName) + '</div>'
    + '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">' + _fmtDate(r.briefing_date) + (r.briefing_time ? ' · ' + r.briefing_time.slice(0, 5) : '') + (r.sks_rep ? ' · ' + esc(r.sks_rep) : '') + '</div></div>'
    + '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">' + _statusPill(r.status) + crew + '</div></div>';
}

function openPrestartForm(id) {
  _safetyArmed.delete('prestart-delete');
  const existing = id ? _prestartCache.find(function(r) { return r.id === id; }) : null;
  if (existing) {
    _prestartDraft = JSON.parse(JSON.stringify(existing));
    _prestartId    = existing.id;
  } else {
    _prestartId   = null;
    _prestartDraft = {
      briefing_date:    _todayIso(),
      briefing_time:    _nowTime(),
      site_abbr:        ((typeof STATE !== 'undefined' && STATE.sites || [])[0] || {}).abbr || '',
      sks_rep:          _currentUser(),
      subcontractor:    '',
      project_name:     '',
      project_number:   '',
      project_address:  '',
      prev_day_issues:  '',
      works_scope:      '',
      crew:             [],
      hrcw_categories:     [],
      permits_categories:  [],
      affects_other_trades: '',
      swms_refs:           '',
      hazards:             '',
      permits:             '',
      photos:           [],
      status:           'draft',
    };
  }
  document.getElementById('prestart-modal-title').textContent = existing ? 'Edit Prestart' : 'New Prestart';
  openModal('modal-prestart');
  renderPrestartForm();
}

function renderPrestartForm() {
  const el = document.getElementById('prestart-form-body');
  if (!el || !_prestartDraft) return;
  const d = _prestartDraft;
  const submitted = d.status === 'submitted';
  const armed     = _safetyArmed.has('prestart-delete');

  let h = '<div style="padding:14px 16px">';

  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += _fld('Project Name', '<input type="text" value="' + esc(d.project_name || '') + '" oninput="_psField(\'project_name\',this.value)" placeholder="e.g. Arncliffe Central" style="' + _I + '">');
  h += _fld('Project Number', '<input type="text" value="' + esc(d.project_number || '') + '" oninput="_psField(\'project_number\',this.value)" placeholder="e.g. 26184" style="' + _I + '">');
  h += '</div>';
  h += _fld('Project Address', '<input type="text" value="' + esc(d.project_address || '') + '" oninput="_psField(\'project_address\',this.value)" placeholder="e.g. 26 Eden St, Arncliffe NSW 2205" style="' + _I + '">');

  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += _fld('Site', '<input type="text" value="' + esc(d.site_abbr || '') + '" oninput="_psField(\'site_abbr\',this.value)" list="ps-site-dl" placeholder="Select or type…" style="' + _I + '">' + _siteDatalist('ps-site-dl'));
  h += _fld('Date', '<input type="date" value="' + esc(d.briefing_date || '') + '" onchange="_psField(\'briefing_date\',this.value)" style="' + _I + '">');
  h += '</div>';

  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += _fld('Time', '<input type="time" value="' + esc(d.briefing_time || '') + '" onchange="_psField(\'briefing_time\',this.value)" style="' + _I + '">');
  h += _fld('Rep / Supervisor', '<input type="text" value="' + esc(d.sks_rep || '') + '" oninput="_psField(\'sks_rep\',this.value)" placeholder="Name" style="' + _I + '">');
  h += '</div>';

  h += _fld('Principal Contractor / Customer', '<input type="text" value="' + esc(d.subcontractor || '') + '" oninput="_psField(\'subcontractor\',this.value)" placeholder="Company or site controller" style="' + _I + '">');
  h += _fld('Scope of works', _taWithMic('ps', 'works_scope', d.works_scope, 'What work is being done today?'));
  h += _fld('Will this work affect other trades?',
    '<div style="display:flex;gap:8px">'
    + ['Yes', 'No'].map(function(v) {
        var sel = d.affects_other_trades === v;
        return '<button type="button" onclick="_psField(\'affects_other_trades\',\'' + v + '\');renderPrestartForm()" '
          + 'style="padding:7px 16px;border:1px solid ' + (sel ? 'var(--blue)' : 'var(--border)') + ';border-radius:7px;font-size:13px;cursor:pointer;'
          + 'background:' + (sel ? 'var(--blue)' : 'var(--surface)') + ';color:' + (sel ? '#fff' : 'var(--ink)') + '">' + v + '</button>';
      }).join('')
    + '</div>');
  h += _fld('Previous day issues', _taWithMic('ps', 'prev_day_issues', d.prev_day_issues, 'Issues, incidents or carry-over actions from yesterday'));

  h += _lbl('High Risk Construction Work (NSW WHS Reg Schedule 3)');
  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:12px">';
  HRCW.forEach(function(cat) {
    const sel = (d.hrcw_categories || []).includes(cat.id);
    h += '<label style="display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid ' + (sel ? 'var(--blue)' : 'var(--border)') + ';border-radius:6px;cursor:pointer;font-size:12px;background:' + (sel ? 'var(--blue-lt)' : 'var(--surface)') + '">'
      + '<input type="checkbox"' + (sel ? ' checked' : '') + ' onchange="_psToggleHrcw(\'' + cat.id + '\',this.checked)" style="flex-shrink:0"> ' + esc(cat.label) + '</label>';
  });
  h += '</div>';

  h += _fld('SWMS references', '<input type="text" value="' + esc(d.swms_refs || '') + '" oninput="_psField(\'swms_refs\',this.value)" placeholder="e.g. SWMS-003, SWMS-007" style="' + _I + '">');
  h += _fld('Hazards identified', _taWithMic('ps', 'hazards', d.hazards, 'Site-specific hazards discussed at this briefing'));

  h += _lbl('Relevant Permits');
  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:12px">';
  PERMITS_CATS.forEach(function(cat) {
    var sel = (d.permits_categories || []).includes(cat.id);
    h += '<label style="display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid ' + (sel ? 'var(--blue)' : 'var(--border)') + ';border-radius:6px;cursor:pointer;font-size:12px;background:' + (sel ? 'var(--blue-lt)' : 'var(--surface)') + '">'
      + '<input type="checkbox"' + (sel ? ' checked' : '') + ' onchange="_psTogglePermit(\'' + cat.id + '\',this.checked)" style="flex-shrink:0"> ' + esc(cat.label) + '</label>';
  });
  h += '</div>';
  h += _fld('Permit notes / other', _taWithMic('ps', 'permits', d.permits, 'Additional permit details or "Other" permit description'));

  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin:16px 0 6px">'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-3)">Crew sign-off</div>'
    + (d.site_abbr ? '<button class="btn btn-secondary btn-sm" onclick="_psRosterPull()">Pull from roster</button>' : '')
    + '</div>';
  (d.crew || []).forEach(function(m, i) {
    const sigStatus = m.signed_at
      ? '<span style="color:#15803d;font-size:11px;font-weight:600">✓ Signed</span>'
      : '<button class="btn btn-secondary btn-sm" onclick="prestartSig(' + i + ')">Sign</button>';
    h += '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">'
      + '<div style="flex:1;font-size:13px">' + esc(m.name || '') + '</div>'
      + sigStatus
      + (m.signature_image ? '<img src="' + esc(m.signature_image) + '" style="height:28px;border:1px solid var(--border);border-radius:4px">' : '')
      + '<button onclick="_psRemoveCrew(' + i + ')" style="background:none;border:none;cursor:pointer;color:var(--ink-3);font-size:15px;padding:0 4px;line-height:1" title="Remove">✕</button>'
      + '</div>';
  });
  h += '<div style="display:flex;gap:8px;margin-top:8px">'
    + '<input type="text" id="ps-crew-input" list="ps-crew-dl" placeholder="Name or select…" style="' + _I + ';flex:1">'
    + _peopleDatalist('ps-crew-dl')
    + '<button class="btn btn-secondary btn-sm" onclick="_psAddCrew()">Add</button></div>';

  h += _lbl('Photos (optional)');
  h += _photoRenderList(d, 'prestart');

  h += '<div style="display:flex;gap:8px;margin-top:20px;padding-top:14px;border-top:1px solid var(--border);flex-wrap:wrap">';
  if (_prestartId) {
    h += '<button class="btn btn-secondary btn-sm" onclick="_psArmDelete()" style="margin-right:auto'
      + (armed ? ';background:var(--red,#dc2626);color:#fff;border-color:var(--red,#dc2626)' : '') + '">'
      + (armed ? 'Tap again to delete' : 'Delete') + '</button>';
  }
  h += '<button class="btn btn-secondary" onclick="closeModal(\'modal-prestart\')">Close</button>';
  h += '<button class="btn btn-secondary" onclick="_psExportDocx()" title="Download as Word document" style="flex-shrink:0">&#8595;&nbsp;Word</button>';
  if (!submitted) h += '<button class="btn" onclick="savePrestartDraft()">Save draft</button>';
  h += !submitted
    ? '<button class="btn" style="background:#15803d;color:#fff;border-color:#15803d" onclick="submitPrestart()">Submit</button>'
    : '<span style="font-size:11px;color:var(--ink-3);align-self:center">Submitted ✓</span>';
  h += '</div></div>';

  el.innerHTML = h;
}

function _psField(key, val) { if (_prestartDraft) _prestartDraft[key] = val; }

function _psToggleHrcw(id, checked) {
  if (!_prestartDraft) return;
  if (!Array.isArray(_prestartDraft.hrcw_categories)) _prestartDraft.hrcw_categories = [];
  if (checked) { if (!_prestartDraft.hrcw_categories.includes(id)) _prestartDraft.hrcw_categories.push(id); }
  else _prestartDraft.hrcw_categories = _prestartDraft.hrcw_categories.filter(function(x) { return x !== id; });
  renderPrestartForm();
}

function _psTogglePermit(id, checked) {
  if (!_prestartDraft) return;
  if (!Array.isArray(_prestartDraft.permits_categories)) _prestartDraft.permits_categories = [];
  if (checked) { if (!_prestartDraft.permits_categories.includes(id)) _prestartDraft.permits_categories.push(id); }
  else _prestartDraft.permits_categories = _prestartDraft.permits_categories.filter(function(x) { return x !== id; });
  renderPrestartForm();
}

function _psAddCrew() {
  const input = document.getElementById('ps-crew-input');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { showToast('Enter a name first'); return; }
  if (!_prestartDraft) return;
  if (!Array.isArray(_prestartDraft.crew)) _prestartDraft.crew = [];
  const people = (typeof STATE !== 'undefined' && STATE.people) || [];
  const person = people.find(function(p) { return p.name === name; });
  _prestartDraft.crew.push({ name: name, person_id: person ? (person.id || null) : null, signed_at: null, signed_by: null, signature_image: null });
  input.value = '';
  renderPrestartForm();
}

function _psRemoveCrew(i) {
  if (!_prestartDraft || !_prestartDraft.crew) return;
  _prestartDraft.crew.splice(i, 1);
  renderPrestartForm();
}

function _psArmDelete() {
  if (_safetyArmed.has('prestart-delete')) {
    _psDoDelete();
  } else {
    _safetyArmed.add('prestart-delete');
    renderPrestartForm();
    setTimeout(function() { _safetyArmed.delete('prestart-delete'); renderPrestartForm(); }, 3000);
  }
}

async function _psDoDelete() {
  if (!_prestartId || _isLocalId(_prestartId)) {
    const idToRemove = _prestartId;
    _prestartDraft = null; _prestartId = null;
    if (idToRemove) _prestartCache = _prestartCache.filter(function(r) { return r.id !== idToRemove; });
    closeModal('modal-prestart'); renderPrestart(); return;
  }
  try {
    await sbFetch('prestarts?id=eq.' + encodeURIComponent(_prestartId), 'DELETE');
    _prestartCache = _prestartCache.filter(function(r) { return r.id !== _prestartId; });
    _prestartDraft = null; _prestartId = null;
    _safetyArmed.delete('prestart-delete');
    closeModal('modal-prestart'); showToast('Prestart deleted'); renderPrestart();
  } catch(e) { showToast('Delete failed — try again'); }
}

function prestartSig(i) {
  if (_prestartDraft) _sigOpen(_prestartDraft, 'crew', i, 'modal-prestart-sig', renderPrestartForm);
}

// Global shims for photo onclick= attributes
function prestartPhotoAdd(input)    { _photoAdd(_prestartDraft, input, renderPrestartForm); }
function prestartPhotoRemove(i)     { _photoRemove(_prestartDraft, i, renderPrestartForm); }
function prestartPhotoCaption(i, v) { _photoSetCaption(_prestartDraft, i, v); }
function prestartPhotoLightbox(i)   { _photoLightbox(_prestartDraft, i); }

function _psBuildPayload() {
  const p = Object.assign({}, _prestartDraft);
  delete p.id;
  if (!_prestartId || _isLocalId(_prestartId)) p.created_by = _currentUser();
  else { delete p.created_by; delete p.created_at; }
  return p;
}

async function savePrestartDraft() {
  if (_prestartInflight.has('save')) return;
  _prestartInflight.add('save');
  try {
    const result = await _qPersist('prestarts', _PS_QKEY, _PS_PILL, _prestartId, _psBuildPayload());
    if (!result._offline && result.id) {
      _prestartId = String(result.id);
      const full = Object.assign({}, _prestartDraft, { id: _prestartId });
      const idx  = _prestartCache.findIndex(function(r) { return String(r.id) === _prestartId; });
      if (idx >= 0) _prestartCache[idx] = full; else _prestartCache.unshift(full);
    }
    showToast('Draft saved');
    renderPrestart(); renderPrestartForm();
  } finally { _prestartInflight.delete('save'); }
}

async function submitPrestart() {
  if (_prestartInflight.has('submit')) return;
  _prestartInflight.add('submit');
  try {
    if (!_prestartDraft) return;
    _prestartDraft.status       = 'submitted';
    _prestartDraft.submitted_at = new Date().toISOString();
    _prestartDraft.submitted_by = _currentUser();
    const result = await _qPersist('prestarts', _PS_QKEY, _PS_PILL, _prestartId, _psBuildPayload());
    if (!result._offline && result.id) {
      _prestartId = String(result.id);
      const full = Object.assign({}, _prestartDraft, { id: _prestartId });
      const idx  = _prestartCache.findIndex(function(r) { return String(r.id) === _prestartId; });
      if (idx >= 0) _prestartCache[idx] = full; else _prestartCache.unshift(full);
    }
    showToast('Prestart submitted ✓');
    renderPrestart(); renderPrestartForm();
  } finally { _prestartInflight.delete('submit'); }
}

// ── Word / .docx export ───────────────────────────────────────
async function _psExportDocx() {
  if (!_prestartDraft) { showToast('No prestart to export'); return; }
  if (typeof JSZip === 'undefined') { showToast('Export requires internet connection'); return; }

  const d = _prestartDraft;
  const siteObj = ((typeof STATE !== 'undefined' && STATE.sites) || []).find(function(s) { return s.abbr === d.site_abbr; });
  const siteName = siteObj ? siteObj.name : (d.site_abbr || '');

  function xe(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Collect signature images
  const sigMap = {};
  let nextRid = 2;
  (d.crew || []).forEach(function(m, i) {
    if (m.signature_image) {
      sigMap[i] = {
        rId: 'rId' + nextRid++,
        base64: m.signature_image.replace(/^data:image\/[^;]+;base64,/, ''),
        fileName: 'sig' + i + '.png'
      };
    }
  });

  // ── Color constants (from Terry Su reference XML) ──────────────
  var NAVY  = '1F335C';  // dark blue — labels, headers
  var LBLUE = 'EEF1F8';  // light blue — value cells
  var LGRAY = 'CCCCCC';  // gray — borders on value cells
  var GREEN = '4caf82';  // green — Yes/No answer text
  var GRNBG = 'e8f5ee';  // green tint — Yes cell background

  var RMAR = '<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>';
  var NBORD = '<w:tcBorders><w:top w:val="single" w:color="' + NAVY + '" w:sz="4" w:space="0"/><w:left w:val="single" w:color="' + NAVY + '" w:sz="4" w:space="0"/><w:bottom w:val="single" w:color="' + NAVY + '" w:sz="4" w:space="0"/><w:right w:val="single" w:color="' + NAVY + '" w:sz="4" w:space="0"/></w:tcBorders>';
  var GBORD = '<w:tcBorders><w:top w:val="single" w:color="' + LGRAY + '" w:sz="1" w:space="0"/><w:left w:val="single" w:color="' + LGRAY + '" w:sz="1" w:space="0"/><w:bottom w:val="single" w:color="' + LGRAY + '" w:sz="1" w:space="0"/><w:right w:val="single" w:color="' + LGRAY + '" w:sz="1" w:space="0"/></w:tcBorders>';

  function arial(text, bold, color) {
    return '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>'
      + (bold ? '<w:b/><w:bCs/>' : '')
      + (color ? '<w:color w:val="' + color + '"/>' : '')
      + '<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
      + '<w:t xml:space="preserve">' + xe(text) + '</w:t></w:r>';
  }

  // Navy label cell
  function tcN(w, text, gridSpan) {
    return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>'
      + (gridSpan ? '<w:gridSpan w:val="' + gridSpan + '"/>' : '')
      + NBORD + '<w:shd w:val="clear" w:color="auto" w:fill="' + NAVY + '"/>' + RMAR
      + '<w:vAlign w:val="center"/></w:tcPr>'
      + '<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:bCs/><w:color w:val="FFFFFF"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
      + '<w:t xml:space="preserve">' + xe(text) + '</w:t></w:r></w:p></w:tc>';
  }

  // Light-blue value cell
  function tcL(w, text, gridSpan) {
    return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>'
      + (gridSpan ? '<w:gridSpan w:val="' + gridSpan + '"/>' : '')
      + GBORD + '<w:shd w:val="clear" w:color="auto" w:fill="' + LBLUE + '"/>' + RMAR
      + '<w:vAlign w:val="center"/></w:tcPr>'
      + '<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
      + '<w:t xml:space="preserve">' + xe(text || '') + '</w:t></w:r></w:p></w:tc>';
  }

  // Light-blue cell with green answer text (Yes/No answers)
  function tcLG(w, text, gridSpan) {
    return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>'
      + (gridSpan ? '<w:gridSpan w:val="' + gridSpan + '"/>' : '')
      + NBORD + '<w:shd w:val="clear" w:color="auto" w:fill="' + LBLUE + '"/>' + RMAR
      + '</w:tcPr>'
      + '<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:bCs/><w:color w:val="' + GREEN + '"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
      + '<w:t xml:space="preserve">' + xe(text || '') + '</w:t></w:r></w:p></w:tc>';
  }

  // Plain white cell (no fill)
  function tcW(w, text) {
    return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>'
      + GBORD + RMAR + '</w:tcPr>'
      + '<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
      + '<w:t xml:space="preserve">' + xe(text || '') + '</w:t></w:r></w:p></w:tc>';
  }

  // Green-tinted Yes cell
  function tcYes() {
    return '<w:tc><w:tcPr><w:tcW w:w="2160" w:type="dxa"/>'
      + GBORD + '<w:shd w:val="clear" w:color="auto" w:fill="' + GRNBG + '"/>' + RMAR
      + '</w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr>'
      + '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:bCs/><w:color w:val="' + GREEN + '"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
      + '<w:t>Yes</w:t></w:r></w:p></w:tc>';
  }

  // Section heading paragraph (bold caps, navy colored — NOT a filled bar)
  function secHead(text) {
    return '<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>'
      + '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:bCs/><w:caps/><w:color w:val="' + NAVY + '"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>'
      + '<w:t>' + xe(text) + '</w:t></w:r></w:p>';
  }

  // HRCW/permit checkbox cell
  function tcChk(w, label, checked) {
    var fill = checked ? GRNBG : LBLUE;
    return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>'
      + GBORD + '<w:shd w:val="clear" w:color="auto" w:fill="' + fill + '"/>' + RMAR
      + '</w:tcPr><w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>'
      + (checked ? '<w:b/><w:bCs/><w:color w:val="' + GREEN + '"/>' : '')
      + '<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
      + '<w:t xml:space="preserve">' + (checked ? '☑ ' : '☐ ') + xe(label) + '</w:t></w:r></w:p></w:tc>';
  }

  function tblOpen4() {
    return '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/></w:tblPr>'
      + '<w:tblGrid><w:gridCol w:w="2340"/><w:gridCol w:w="2340"/><w:gridCol w:w="2340"/><w:gridCol w:w="2340"/></w:tblGrid>';
  }
  function tblOpen2(c1, c2) {
    return '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/></w:tblPr>'
      + '<w:tblGrid><w:gridCol w:w="' + c1 + '"/><w:gridCol w:w="' + c2 + '"/></w:tblGrid>';
  }
  function tblOpen3(c1, c2, c3) {
    return '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/></w:tblPr>'
      + '<w:tblGrid><w:gridCol w:w="' + c1 + '"/><w:gridCol w:w="' + c2 + '"/><w:gridCol w:w="' + c3 + '"/></w:tblGrid>';
  }
  function tblOpen1() {
    return '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/></w:tblPr>'
      + '<w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid>';
  }

  function spacer() { return '<w:p><w:pPr><w:spacing w:before="200" w:after="0"/></w:pPr></w:p>'; }
  function spacerSm() { return '<w:p><w:pPr><w:spacing w:before="100" w:after="0"/></w:pPr></w:p>'; }

  function imgRun(sig) {
    if (!sig) return '';
    var cx = 1371600, cy = 457200;
    return '<w:r><w:drawing>'
      + '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
      + '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
      + '<wp:docPr id="' + sig.rId + '" name="' + xe(sig.fileName) + '"/>'
      + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
      + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<pic:nvPicPr><pic:cNvPr id="1" name="' + xe(sig.fileName) + '"/><pic:cNvPicPr/></pic:nvPicPr>'
      + '<pic:blipFill><a:blip r:embed="' + sig.rId + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>'
      + '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
      + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
      + '</pic:pic></a:graphicData></a:graphic>'
      + '</wp:inline></w:drawing></w:r>';
  }

  // ── Build document body ───────────────────────────────────────
  var body = '';

  // Title — Roboto font, navy, 16pt bold, centered (matches Terry Su reference)
  body += '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/></w:pPr>'
    + '<w:r><w:rPr><w:rFonts w:ascii="Roboto" w:hAnsi="Roboto" w:cs="Roboto"/><w:b/><w:bCs/><w:color w:val="' + NAVY + '"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>'
    + '<w:t>SKS DAILY PRE-START</w:t></w:r></w:p>';

  // Info table — 4-column (2340×4): label cells navy, value cells light blue
  body += tblOpen4();
  body += '<w:tr>' + tcN(2340,'Project Name:') + tcL(2340,d.project_name) + tcN(2340,'Project Number:') + tcL(2340,d.project_number) + '</w:tr>';
  body += '<w:tr>' + tcN(2340,'Project Address:') + tcL(7020,d.project_address,3) + '</w:tr>';
  body += '<w:tr>' + tcN(2340,'Date:') + tcL(2340,_fmtDate(d.briefing_date)) + tcN(2340,'Time:') + tcL(2340,d.briefing_time ? d.briefing_time.slice(0,5) : '') + '</w:tr>';
  body += '<w:tr>' + tcN(2340,'SKS Representative:') + tcL(7020,d.sks_rep,3) + '</w:tr>';
  body += '<w:tr>' + tcN(2340,'Sub-Contractor:') + tcL(7020,d.subcontractor,3) + '</w:tr>';
  if (siteName) body += '<w:tr>' + tcN(2340,'Site:') + tcL(7020,siteName,3) + '</w:tr>';
  body += '</w:tbl>';

  body += spacer();

  // Safety issues — 2-col inline table (question left navy, answer right light-blue+green)
  body += tblOpen2(6360,3000);
  body += '<w:tr>' + tcN(6360,'Are there any Safety issues arising from the previous workday?') + tcLG(3000,d.prev_day_issues || 'No') + '</w:tr>';
  body += '</w:tbl>';

  body += spacerSm();

  // Works scope — full-width 2-row table
  body += tblOpen1();
  body += '<w:tr>' + tcN(9360,'What Works are taking Place Today, By Who & Where?') + '</w:tr>';
  body += '<w:tr>' + tcL(9360,d.works_scope) + '</w:tr>';
  body += '</w:tbl>';

  body += spacerSm();

  // Affects other trades — 2-col inline table
  body += tblOpen2(6360,3000);
  body += '<w:tr>' + tcN(6360,'Will this work affect other trades?') + tcLG(3000,d.affects_other_trades || '') + '</w:tr>';
  body += '</w:tbl>';

  if (d.swms_refs) {
    body += spacerSm();
    body += tblOpen2(6360,3000);
    body += '<w:tr>' + tcN(6360,'SWMS References:') + tcL(3000,d.swms_refs) + '</w:tr>';
    body += '</w:tbl>';
  }

  // Controls
  var CONTROLS = [
    ['Slips Trips and Falls',      'Housekeeping'],
    ['Cuts Scrapes and Abrasions', 'Correct PPE'],
    ['Manual Handling',            'Correct Manual Handling Technique'],
    ['Using Power tools',          'Tags are up to date, Correct Use of tools, Right tool for right job'],
    ['Use of knifes',              'NO KNIFES'],
  ];
  body += secHead('Controls');
  body += tblOpen2(6000,3360);
  body += '<w:tr>' + tcN(6000,'Control') + tcN(3360,'Action By') + '</w:tr>';
  CONTROLS.forEach(function(r) {
    body += '<w:tr>' + tcL(6000,r[0]) + tcL(3360,r[1]) + '</w:tr>';
  });
  body += '</w:tbl>';

  // Measures — 3-col (720 num navy | 6480 text white | 2160 yes green)
  var MEASURES = [
    'Scope of work and responsibilities for the day discussed and understood.',
    'SWMS for today\'s work reviewed, understood, and approved by all workers.',
    'Work Methods / Procedures discussed and understood.',
    'All relevant permits to work are in place and understood.',
    'Tools including all Equipment checked and in good working order & displays current tag evidence.',
    'All workers have the appropriate PPE for tasks being undertaken on site.',
    'Housekeeping issues have been discussed & understood.',
    'Materials and equipment to be used discussed & understood.',
  ];
  body += secHead("Measures for Today's Work Scope");
  body += tblOpen3(720,6480,2160);
  MEASURES.forEach(function(m, i) {
    body += '<w:tr>' + tcN(720,String(i+1)+'.') + tcW(6480,m) + tcYes() + '</w:tr>';
  });
  body += '</w:tbl>';

  // Other hazards
  var BLANK_HAZ = '<w:tr>'
    + tcL(5760,' ') + tcL(2400,' ') + tcL(1200,' ')
    + '</w:tr>';
  body += secHead('Other Hazards & Risks');
  body += tblOpen3(5760,2400,1200);
  body += '<w:tr>' + tcN(5760,'Hazard / Risk') + tcN(2400,'Action By') + tcN(1200,'When') + '</w:tr>';
  if (d.hazards) body += '<w:tr>' + tcL(5760,d.hazards) + tcL(2400,'') + tcL(1200,'') + '</w:tr>';
  body += BLANK_HAZ + BLANK_HAZ + BLANK_HAZ;
  body += '</w:tbl>';

  // HRCW checkboxes
  body += secHead('High Risk Construction Work (NSW WHS Reg Schedule 3)');
  body += tblOpen2(4680,4680);
  for (var hi = 0; hi < HRCW.length; hi += 2) {
    var lCat = HRCW[hi], rCat = HRCW[hi+1];
    var lChk = (d.hrcw_categories || []).indexOf(lCat.id) >= 0;
    var rChk = rCat && (d.hrcw_categories || []).indexOf(rCat.id) >= 0;
    body += '<w:tr>' + tcChk(4680,lCat.label,lChk) + (rCat ? tcChk(4680,rCat.label,rChk) : tcL(4680,'')) + '</w:tr>';
  }
  body += '</w:tbl>';

  // Relevant Permits
  body += secHead('Relevant Permits');
  body += tblOpen2(4680,4680);
  for (var pi = 0; pi < PERMITS_CATS.length; pi += 2) {
    var lp = PERMITS_CATS[pi], rp = PERMITS_CATS[pi+1];
    var lpChk = (d.permits_categories || []).indexOf(lp.id) >= 0;
    var rpChk = rp && (d.permits_categories || []).indexOf(rp.id) >= 0;
    body += '<w:tr>' + tcChk(4680,lp.label,lpChk) + (rp ? tcChk(4680,rp.label,rpChk) : tcL(4680,'')) + '</w:tr>';
  }
  body += '</w:tbl>';
  if (d.permits) {
    body += '<w:p><w:pPr><w:spacing w:before="40" w:after="60"/><w:ind w:left="200"/></w:pPr>'
      + arial('Notes: ' + d.permits, false, null) + '</w:p>';
  }

  // Declaration
  body += secHead('Declaration');
  body += tblOpen1();
  body += '<w:tr><w:tc><w:tcPr><w:tcW w:w="9360" w:type="dxa"/>'
    + GBORD + '<w:shd w:val="clear" w:color="auto" w:fill="' + LBLUE + '"/>' + RMAR
    + '</w:tcPr><w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:i/><w:iCs/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>'
    + '<w:t xml:space="preserve">'
    + xe('I have reviewed today\'s scope of works and associated SWMS and agree to comply with all the controls. '
      + 'If the task changes for any reason the SWMS will be reviewed to and where applicable will be amended to reflect the change in task.')
    + '</w:t></w:r></w:p></w:tc></w:tr>';
  body += '</w:tbl>';

  // Signatures
  body += secHead('Signatures');
  var crew = d.crew || [];
  if (crew.length) {
    body += tblOpen2(4680,4680);
    body += '<w:tr>' + tcN(4680,'Name & Signature') + tcN(4680,'Signature') + '</w:tr>';
    crew.forEach(function(m, i) {
      var sig = sigMap[i];
      var sigContent = sig
        ? '<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>' + imgRun(sig) + '</w:p>'
        : '<w:p><w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr>' + arial('Not signed', false, LGRAY) + '</w:p>';
      body += '<w:tr>' + tcL(4680,m.name || '') + '<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/>' + GBORD + '<w:shd w:val="clear" w:color="auto" w:fill="' + LBLUE + '"/>' + RMAR + '</w:tcPr>' + sigContent + '</w:tc></w:tr>';
    });
    body += '</w:tbl>';
  } else {
    body += '<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>' + arial('No crew recorded.', false, LGRAY) + '</w:p>';
  }

  // Footer
  body += '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="200" w:after="0"/></w:pPr>'
    + '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="16"/><w:szCs w:val="16"/><w:color w:val="' + LGRAY + '"/></w:rPr>'
    + '<w:t>Daily Prestart  |  Page 1 of 1  |  Generated by EQ Solves — Field</w:t></w:r></w:p>';

  // ── Relationships ─────────────────────────────────────────────
  var docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  Object.keys(sigMap).forEach(function(k) {
    var sig = sigMap[k];
    docRels += '<Relationship Id="' + sig.rId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + sig.fileName + '"/>';
  });
  docRels += '</Relationships>';

  var hasSigs = Object.keys(sigMap).length > 0;

  var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + (hasSigs ? '<Default Extension="png" ContentType="image/png"/>' : '')
    + '</Types>';

  var dotRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  var stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr>'
    + '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>'
    + '<w:sz w:val="18"/><w:szCs w:val="18"/>'
    + '</w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr></w:pPrDefault>'
    + '</w:docDefaults></w:styles>';

  var docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
    + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
    + ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<w:body>'
    + body
    + '<w:sectPr>'
    + '<w:pgSz w:w="11906" w:h="16838"/>'
    + '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/>'
    + '</w:sectPr>'
    + '</w:body></w:document>';

  // ── Package and download ──────────────────────────────────────
  var zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels').file('.rels', dotRels);
  var wFolder = zip.folder('word');
  wFolder.file('document.xml', docXml);
  wFolder.file('styles.xml', stylesXml);
  wFolder.folder('_rels').file('document.xml.rels', docRels);
  if (hasSigs) {
    var mFolder = wFolder.folder('media');
    Object.keys(sigMap).forEach(function(k) {
      var sig = sigMap[k];
      mFolder.file(sig.fileName, sig.base64, { base64: true });
    });
  }

  var repStr  = (d.sks_rep || 'Rep').replace(/[^a-zA-Z0-9]/g, '_');
  var dateStr = (d.briefing_date || '').replace(/-/g, '');
  var siteStr = (siteName || d.site_abbr || 'Site').replace(/[^a-zA-Z0-9]/g, '_');
  var fileName = 'PreStart_' + repStr + '_' + dateStr + '_' + siteStr + '.docx';

  try {
    var blob = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Word doc downloaded');
  } catch(e) {
    console.error('EQ[safety] docx export failed:', e);
    showToast('Export failed — try again');
  }
}

// ════════════════════════════════════════════════════════════════
// TOOLBOX TALKS
// ════════════════════════════════════════════════════════════════

const _TB_QKEY = 'sks_toolbox_offline_queue_v1';
const _TB_PILL = 'toolbox-offline-pill';

async function loadToolboxTalks() {
  try {
    const rows = await sbFetch('toolbox_talks?select=*&order=meeting_date.desc,meeting_time.desc&limit=200');
    _toolboxCache = Array.isArray(rows) ? rows : [];
  } catch(e) {
    console.warn('EQ[safety/toolbox] load failed:', e && e.message || e);
    _toolboxCache = [];
  }
}

function renderToolbox() {
  const el = document.getElementById('page-toolbox-list');
  if (!el) return;
  _injectSafetyStyle();
  const today  = _todayIso();
  const todays = _toolboxCache.filter(function(r) { return r.meeting_date === today; });
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14);
  const recent = _toolboxCache.filter(function(r) { return r.meeting_date !== today && new Date(r.meeting_date) >= cutoff; });

  let h = '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface)">'
    + '<div><div style="font-size:13px;font-weight:700">Toolbox Talks</div>'
    + '<div style="font-size:11px;color:var(--ink-3);margin-top:1px">' + todays.length + ' today · ' + _toolboxCache.length + ' total</div></div>'
    + '<button class="btn" onclick="openToolboxForm()">＋ New</button></div>';

  h += todays.length
    ? todays.map(_toolboxRow).join('')
    : '<div style="padding:12px 16px;font-size:12px;color:var(--ink-3);background:var(--surface-2);border-bottom:1px solid var(--border)">No toolbox talks today — tap <strong>New</strong> to create one.</div>';

  if (recent.length) {
    h += '<div style="padding:5px 16px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-3);background:var(--surface-2);border-bottom:1px solid var(--border);border-top:1px solid var(--border)">Past 2 weeks</div>';
    h += recent.map(_toolboxRow).join('');
  }
  el.innerHTML = h;
}

function _toolboxRow(r) {
  const site  = (typeof STATE !== 'undefined' && STATE.sites || []).find(function(s) { return s.abbr === r.site_abbr; });
  const sName = site ? site.name : (r.site_abbr || 'No site');
  const signed = (r.attendance || []).filter(function(a) { return a.signed_at; }).length;
  const total  = (r.attendance || []).length;
  const att    = total ? '<span style="font-size:11px;color:var(--ink-3)">' + signed + '/' + total + ' signed</span>' : '';
  const topicStr = r.topic ? ' · ' + esc(r.topic) : '';
  return '<div onclick="openToolboxForm(\'' + esc(r.id) + '\')" style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;background:var(--surface)" onmouseover="this.style.background=\'var(--surface-2)\'" onmouseout="this.style.background=\'var(--surface)\'">'
    + '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(sName) + topicStr + '</div>'
    + '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">' + _fmtDate(r.meeting_date) + (r.meeting_time ? ' · ' + r.meeting_time.slice(0, 5) : '') + (r.facilitator ? ' · ' + esc(r.facilitator) : '') + '</div></div>'
    + '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">' + _statusPill(r.status) + att + '</div></div>';
}

function openToolboxForm(id) {
  _safetyArmed.delete('toolbox-delete');
  const existing = id ? _toolboxCache.find(function(r) { return r.id === id; }) : null;
  if (existing) {
    _toolboxDraft = JSON.parse(JSON.stringify(existing));
    _toolboxId    = existing.id;
  } else {
    _toolboxId   = null;
    _toolboxDraft = {
      meeting_date:    _todayIso(),
      meeting_time:    _nowTime(),
      site_abbr:       ((typeof STATE !== 'undefined' && STATE.sites || [])[0] || {}).abbr || '',
      facilitator:     _currentUser(),
      subcontractor:   '',
      topic:           '',
      safety_message:  '',
      items_reviewed:  '',
      open_actions:    '',
      hazards:         '',
      swms_refs:       '',
      next_meeting:    '',
      attendance:      [],
      photos:          [],
      status:          'draft',
    };
  }
  document.getElementById('toolbox-modal-title').textContent = existing ? 'Edit Toolbox Talk' : 'New Toolbox Talk';
  openModal('modal-toolbox');
  renderToolboxForm();
}

function renderToolboxForm() {
  const el = document.getElementById('toolbox-form-body');
  if (!el || !_toolboxDraft) return;
  const d = _toolboxDraft;
  const submitted = d.status === 'submitted';
  const armed     = _safetyArmed.has('toolbox-delete');

  let h = '<div style="padding:14px 16px">';

  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += _fld('Site', '<input type="text" value="' + esc(d.site_abbr || '') + '" oninput="_tbField(\'site_abbr\',this.value)" list="tb-site-dl" placeholder="Select or type…" style="' + _I + '">' + _siteDatalist('tb-site-dl'));
  h += _fld('Date', '<input type="date" value="' + esc(d.meeting_date || '') + '" onchange="_tbField(\'meeting_date\',this.value)" style="' + _I + '">');
  h += '</div>';

  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += _fld('Time', '<input type="time" value="' + esc(d.meeting_time || '') + '" onchange="_tbField(\'meeting_time\',this.value)" style="' + _I + '">');
  h += _fld('Facilitator', '<input type="text" value="' + esc(d.facilitator || '') + '" oninput="_tbField(\'facilitator\',this.value)" placeholder="Name" style="' + _I + '">');
  h += '</div>';

  h += _fld('Principal Contractor / Customer', '<input type="text" value="' + esc(d.subcontractor || '') + '" oninput="_tbField(\'subcontractor\',this.value)" placeholder="Company or site controller" style="' + _I + '">');
  h += _fld('Topic', '<input type="text" value="' + esc(d.topic || '') + '" oninput="_tbField(\'topic\',this.value)" placeholder="Main topic of the talk" style="' + _I + '">');
  h += _fld('Key safety message', _taWithMic('tb', 'safety_message', d.safety_message, 'The single most important takeaway'));
  h += _fld('Items reviewed', _taWithMic('tb', 'items_reviewed', d.items_reviewed, 'What was covered at the meeting?'));
  h += _fld('Open actions from last talk', _taWithMic('tb', 'open_actions', d.open_actions, "Carry-over items that haven't been resolved yet"));
  h += _fld('Hazards discussed', _taWithMic('tb', 'hazards', d.hazards, 'Site-specific hazards raised'));

  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += _fld('SWMS references', '<input type="text" value="' + esc(d.swms_refs || '') + '" oninput="_tbField(\'swms_refs\',this.value)" placeholder="SWMS-001, SWMS-004" style="' + _I + '">');
  h += _fld('Next meeting', '<input type="date" value="' + esc(d.next_meeting || '') + '" onchange="_tbField(\'next_meeting\',this.value)" style="' + _I + '">');
  h += '</div>';

  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin:16px 0 6px">'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--ink-3)">Attendance</div>'
    + (d.site_abbr ? '<button class="btn btn-secondary btn-sm" onclick="_tbRosterPull()">Pull from roster</button>' : '')
    + '</div>';
  (d.attendance || []).forEach(function(m, i) {
    const sigStatus = m.signed_at
      ? '<span style="color:#15803d;font-size:11px;font-weight:600">✓ Signed</span>'
      : '<button class="btn btn-secondary btn-sm" onclick="toolboxSig(' + i + ')">Sign</button>';
    h += '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)">'
      + '<div style="flex:1;font-size:13px">' + esc(m.name || '') + '</div>'
      + sigStatus
      + (m.signature_image ? '<img src="' + esc(m.signature_image) + '" style="height:28px;border:1px solid var(--border);border-radius:4px">' : '')
      + '<button onclick="_tbRemoveAtt(' + i + ')" style="background:none;border:none;cursor:pointer;color:var(--ink-3);font-size:15px;padding:0 4px;line-height:1" title="Remove">✕</button>'
      + '</div>';
  });
  h += '<div style="display:flex;gap:8px;margin-top:8px">'
    + '<input type="text" id="tb-att-input" list="tb-att-dl" placeholder="Name or select…" style="' + _I + ';flex:1">'
    + _peopleDatalist('tb-att-dl')
    + '<button class="btn btn-secondary btn-sm" onclick="_tbAddAtt()">Add</button></div>';

  h += _lbl('Photos (optional)');
  h += _photoRenderList(d, 'toolbox');

  h += '<div style="display:flex;gap:8px;margin-top:20px;padding-top:14px;border-top:1px solid var(--border);flex-wrap:wrap">';
  if (_toolboxId) {
    h += '<button class="btn btn-secondary btn-sm" onclick="_tbArmDelete()" style="margin-right:auto'
      + (armed ? ';background:var(--red,#dc2626);color:#fff;border-color:var(--red,#dc2626)' : '') + '">'
      + (armed ? 'Tap again to delete' : 'Delete') + '</button>';
  }
  h += '<button class="btn btn-secondary" onclick="closeModal(\'modal-toolbox\')">Close</button>';
  if (!submitted) h += '<button class="btn" onclick="saveToolboxDraft()">Save draft</button>';
  h += !submitted
    ? '<button class="btn" style="background:#15803d;color:#fff;border-color:#15803d" onclick="submitToolbox()">Submit</button>'
    : '<span style="font-size:11px;color:var(--ink-3);align-self:center">Submitted ✓</span>';
  h += '</div></div>';

  el.innerHTML = h;
}

function _tbField(key, val) { if (_toolboxDraft) _toolboxDraft[key] = val; }

function _tbAddAtt() {
  const input = document.getElementById('tb-att-input');
  if (!input) return;
  const name = input.value.trim();
  if (!name) { showToast('Enter a name first'); return; }
  if (!_toolboxDraft) return;
  if (!Array.isArray(_toolboxDraft.attendance)) _toolboxDraft.attendance = [];
  const people = (typeof STATE !== 'undefined' && STATE.people) || [];
  const person = people.find(function(p) { return p.name === name; });
  _toolboxDraft.attendance.push({ name: name, person_id: person ? (person.id || null) : null, signed_at: null, signed_by: null, signature_image: null });
  input.value = '';
  renderToolboxForm();
}

function _tbRemoveAtt(i) {
  if (!_toolboxDraft || !_toolboxDraft.attendance) return;
  _toolboxDraft.attendance.splice(i, 1);
  renderToolboxForm();
}

function _tbArmDelete() {
  if (_safetyArmed.has('toolbox-delete')) {
    _tbDoDelete();
  } else {
    _safetyArmed.add('toolbox-delete');
    renderToolboxForm();
    setTimeout(function() { _safetyArmed.delete('toolbox-delete'); renderToolboxForm(); }, 3000);
  }
}

async function _tbDoDelete() {
  if (!_toolboxId || _isLocalId(_toolboxId)) {
    const idToRemove = _toolboxId;
    _toolboxDraft = null; _toolboxId = null;
    if (idToRemove) _toolboxCache = _toolboxCache.filter(function(r) { return r.id !== idToRemove; });
    closeModal('modal-toolbox'); renderToolbox(); return;
  }
  try {
    await sbFetch('toolbox_talks?id=eq.' + encodeURIComponent(_toolboxId), 'DELETE');
    _toolboxCache = _toolboxCache.filter(function(r) { return r.id !== _toolboxId; });
    _toolboxDraft = null; _toolboxId = null;
    _safetyArmed.delete('toolbox-delete');
    closeModal('modal-toolbox'); showToast('Toolbox talk deleted'); renderToolbox();
  } catch(e) { showToast('Delete failed — try again'); }
}

function toolboxSig(i) {
  if (_toolboxDraft) _sigOpen(_toolboxDraft, 'attendance', i, 'modal-toolbox-sig', renderToolboxForm);
}

// Global shims for photo onclick= attributes
function toolboxPhotoAdd(input)    { _photoAdd(_toolboxDraft, input, renderToolboxForm); }
function toolboxPhotoRemove(i)     { _photoRemove(_toolboxDraft, i, renderToolboxForm); }
function toolboxPhotoCaption(i, v) { _photoSetCaption(_toolboxDraft, i, v); }
function toolboxPhotoLightbox(i)   { _photoLightbox(_toolboxDraft, i); }

function _tbBuildPayload() {
  const p = Object.assign({}, _toolboxDraft);
  delete p.id;
  p.next_meeting = p.next_meeting || null;
  if (!_toolboxId || _isLocalId(_toolboxId)) p.created_by = _currentUser();
  else { delete p.created_by; delete p.created_at; }
  return p;
}

async function saveToolboxDraft() {
  if (_toolboxInflight.has('save')) return;
  _toolboxInflight.add('save');
  try {
    const result = await _qPersist('toolbox_talks', _TB_QKEY, _TB_PILL, _toolboxId, _tbBuildPayload());
    if (!result._offline && result.id) {
      _toolboxId = String(result.id);
      const full = Object.assign({}, _toolboxDraft, { id: _toolboxId });
      const idx  = _toolboxCache.findIndex(function(r) { return String(r.id) === _toolboxId; });
      if (idx >= 0) _toolboxCache[idx] = full; else _toolboxCache.unshift(full);
    }
    showToast('Draft saved');
    renderToolbox(); renderToolboxForm();
  } finally { _toolboxInflight.delete('save'); }
}

async function submitToolbox() {
  if (_toolboxInflight.has('submit')) return;
  _toolboxInflight.add('submit');
  try {
    if (!_toolboxDraft) return;
    _toolboxDraft.status       = 'submitted';
    _toolboxDraft.submitted_at = new Date().toISOString();
    _toolboxDraft.submitted_by = _currentUser();
    const result = await _qPersist('toolbox_talks', _TB_QKEY, _TB_PILL, _toolboxId, _tbBuildPayload());
    if (!result._offline && result.id) {
      _toolboxId = String(result.id);
      const full = Object.assign({}, _toolboxDraft, { id: _toolboxId });
      const idx  = _toolboxCache.findIndex(function(r) { return String(r.id) === _toolboxId; });
      if (idx >= 0) _toolboxCache[idx] = full; else _toolboxCache.unshift(full);
    }
    showToast('Toolbox talk submitted ✓');
    renderToolbox(); renderToolboxForm();
  } finally { _toolboxInflight.delete('submit'); }
}

// ── Page entry point ───────────────────────────────────────────
let _safetyOnlineHandler = null;
let _safetyLoaded = false;

async function loadSafety() {
  if (_safetyLoaded) { showSafetyTab(_safetyTab); return; }
  _safetyLoaded = true;
  await Promise.all([loadPrestarts(), loadToolboxTalks()]);
  showSafetyTab(_safetyTab);
  // Register online replay once
  if (!_safetyOnlineHandler) {
    _safetyOnlineHandler = function() {
      _qReplay(_PS_QKEY, _PS_PILL, function() { loadPrestarts().then(renderPrestart); });
      _qReplay(_TB_QKEY, _TB_PILL, function() { loadToolboxTalks().then(renderToolbox); });
    };
    window.addEventListener('online', _safetyOnlineHandler);
    // Replay any queued writes from before this page load
    _qReplay(_PS_QKEY, _PS_PILL, function() { loadPrestarts().then(renderPrestart); });
    _qReplay(_TB_QKEY, _TB_PILL, function() { loadToolboxTalks().then(renderToolbox); });
  }
}
