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

// ── Shared helpers ─────────────────────────────────────────────
function _todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function _nowTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
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

function _siteOptions(selected) {
  const sites = (typeof STATE !== 'undefined' && STATE.sites) || [];
  return sites.map(function(s) {
    return '<option value="' + esc(s.abbr) + '"' + (s.abbr === selected ? ' selected' : '') + '>' + esc(s.name || s.abbr) + '</option>';
  }).join('');
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
      prev_day_issues:  '',
      works_scope:      '',
      crew:             [],
      hrcw_categories:  [],
      swms_refs:        '',
      hazards:          '',
      permits:          '',
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
  h += _fld('Site', '<select onchange="_psField(\'site_abbr\',this.value)" style="' + _I + '"><option value="">— select —</option>' + _siteOptions(d.site_abbr) + '</select>');
  h += _fld('Date', '<input type="date" value="' + esc(d.briefing_date || '') + '" onchange="_psField(\'briefing_date\',this.value)" style="' + _I + '">');
  h += '</div>';

  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += _fld('Time', '<input type="time" value="' + esc(d.briefing_time || '') + '" onchange="_psField(\'briefing_time\',this.value)" style="' + _I + '">');
  h += _fld('Rep / Supervisor', '<input type="text" value="' + esc(d.sks_rep || '') + '" oninput="_psField(\'sks_rep\',this.value)" placeholder="Name" style="' + _I + '">');
  h += '</div>';

  h += _fld('Subcontractor', '<input type="text" value="' + esc(d.subcontractor || '') + '" oninput="_psField(\'subcontractor\',this.value)" placeholder="Company or team (if applicable)" style="' + _I + '">');
  h += _fld('Scope of works', '<textarea oninput="_psField(\'works_scope\',this.value)" placeholder="What work is being done today?" style="' + _TA + '">' + esc(d.works_scope || '') + '</textarea>');
  h += _fld('Previous day issues', '<textarea oninput="_psField(\'prev_day_issues\',this.value)" placeholder="Issues, incidents or carry-over actions from yesterday" style="' + _TA + '">' + esc(d.prev_day_issues || '') + '</textarea>');

  h += _lbl('High Risk Construction Work (NSW WHS Reg Schedule 3)');
  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:12px">';
  HRCW.forEach(function(cat) {
    const sel = (d.hrcw_categories || []).includes(cat.id);
    h += '<label style="display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid ' + (sel ? 'var(--blue)' : 'var(--border)') + ';border-radius:6px;cursor:pointer;font-size:12px;background:' + (sel ? 'var(--blue-lt)' : 'var(--surface)') + '">'
      + '<input type="checkbox"' + (sel ? ' checked' : '') + ' onchange="_psToggleHrcw(\'' + cat.id + '\',this.checked)" style="flex-shrink:0"> ' + esc(cat.label) + '</label>';
  });
  h += '</div>';

  h += _fld('SWMS references', '<input type="text" value="' + esc(d.swms_refs || '') + '" oninput="_psField(\'swms_refs\',this.value)" placeholder="e.g. SWMS-003, SWMS-007" style="' + _I + '">');
  h += _fld('Hazards identified', '<textarea oninput="_psField(\'hazards\',this.value)" placeholder="Site-specific hazards discussed at this briefing" style="' + _TA + '">' + esc(d.hazards || '') + '</textarea>');
  h += _fld('Permits required', '<textarea oninput="_psField(\'permits\',this.value)" placeholder="Permits to work — hot work, confined space, access" style="' + _TA + '">' + esc(d.permits || '') + '</textarea>');

  h += _lbl('Crew sign-off');
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
  h += _fld('Site', '<select onchange="_tbField(\'site_abbr\',this.value)" style="' + _I + '"><option value="">— select —</option>' + _siteOptions(d.site_abbr) + '</select>');
  h += _fld('Date', '<input type="date" value="' + esc(d.meeting_date || '') + '" onchange="_tbField(\'meeting_date\',this.value)" style="' + _I + '">');
  h += '</div>';

  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += _fld('Time', '<input type="time" value="' + esc(d.meeting_time || '') + '" onchange="_tbField(\'meeting_time\',this.value)" style="' + _I + '">');
  h += _fld('Facilitator', '<input type="text" value="' + esc(d.facilitator || '') + '" oninput="_tbField(\'facilitator\',this.value)" placeholder="Name" style="' + _I + '">');
  h += '</div>';

  h += _fld('Subcontractor', '<input type="text" value="' + esc(d.subcontractor || '') + '" oninput="_tbField(\'subcontractor\',this.value)" placeholder="Company or team (if applicable)" style="' + _I + '">');
  h += _fld('Topic', '<input type="text" value="' + esc(d.topic || '') + '" oninput="_tbField(\'topic\',this.value)" placeholder="Main topic of the talk" style="' + _I + '">');
  h += _fld('Key safety message', '<textarea oninput="_tbField(\'safety_message\',this.value)" placeholder="The single most important takeaway" style="' + _TA + '">' + esc(d.safety_message || '') + '</textarea>');
  h += _fld('Items reviewed', '<textarea oninput="_tbField(\'items_reviewed\',this.value)" placeholder="What was covered at the meeting?" style="' + _TA + '">' + esc(d.items_reviewed || '') + '</textarea>');
  h += _fld('Open actions from last talk', '<textarea oninput="_tbField(\'open_actions\',this.value)" placeholder="Carry-over items that haven\'t been resolved yet" style="' + _TA + '">' + esc(d.open_actions || '') + '</textarea>');
  h += _fld('Hazards discussed', '<textarea oninput="_tbField(\'hazards\',this.value)" placeholder="Site-specific hazards raised" style="' + _TA + '">' + esc(d.hazards || '') + '</textarea>');

  h += '<div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  h += _fld('SWMS references', '<input type="text" value="' + esc(d.swms_refs || '') + '" oninput="_tbField(\'swms_refs\',this.value)" placeholder="SWMS-001, SWMS-004" style="' + _I + '">');
  h += _fld('Next meeting', '<input type="date" value="' + esc(d.next_meeting || '') + '" onchange="_tbField(\'next_meeting\',this.value)" style="' + _I + '">');
  h += '</div>';

  h += _lbl('Attendance');
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
