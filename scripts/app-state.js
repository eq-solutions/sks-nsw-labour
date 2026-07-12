/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/app-state.js  —  EQ Solves Field
// Global state, tenant detection, SEED data, config loading.
// Must be the FIRST script loaded.
// ─────────────────────────────────────────────────────────────

// ── Version ───────────────────────────────────────────────────
const APP_VERSION = '3.10.96';

// ── Hostname → tenant slug map ────────────────────────────────
const HOSTNAME_MAP = {
  'sks-nsw-labour.netlify.app': 'sks',
  'eq-solves-field.netlify.app': 'eq',
  'localhost': 'eq',
  '127.0.0.1': 'eq',
};

// Per-tenant Supabase credentials (public anon keys — safe to embed)
const TENANT_SUPABASE = {
  eq: {
    url: 'https://ktmjmdzqrogauaevbktn.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt0bWptZHpxcm9nYXVhZXZia3RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MzA3MzUsImV4cCI6MjA5MTIwNjczNX0.QwXUvO1Wd1YV_UlCBkgJNjzCXd-2homD2sQ2bIrAgC4'
  },
  sks: {
    url: 'https://nspbmirochztcjijmcrx.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zcGJtaXJvY2h6dGNqaWptY3J4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2ODg2MjQsImV4cCI6MjA5MDI2NDYyNH0.cpwHUqWr7MKaJFP0K7RMt43CytJ_dnPAH3LJ3xEdEdg'
  }
};

function _detectTenantSlug() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('tenant')) return params.get('tenant');
  const h = window.location.hostname;
  // Exact match first
  if (HOSTNAME_MAP[h]) return HOSTNAME_MAP[h];
  // Substring match for Netlify deploy previews and branch deploys
  // e.g. deploy-preview-1--sks-nsw-labour.netlify.app, v3-3-2-test--sks-nsw-labour.netlify.app
  if (h.indexOf('sks-nsw-labour') !== -1) return 'sks';
  if (h.indexOf('eq-solves-field') !== -1) return 'eq';
  // v3.4.77: fallback flipped from 'eq' to 'sks'. The 2026-05-20 repo
  // split made this an SKS-only codebase — the original EQ default
  // was protection against a multi-tenant ambiguity that no longer
  // exists here. Effect: unknown hosts (file://, localhost, any new
  // CDN we add later) render the SKS palette + logo + access codes
  // rather than EQ defaults. Production hostnames hit the exact /
  // substring matches above; this only changes the fallback case.
  return 'sks';
}

// ── Tenant config (populated by loadTenantConfig) ─────────────
let TENANT = {
  ORG_SLUG: 'eq',
  ORG_UUID: null,
  ORG_NAME: 'EQ Solves — Field',
  PIPELINE_ENABLED: false,
};

let SB_URL         = '';
let SB_KEY         = '';
let MANAGER_PASSWORD = '';

// Worker group categories — the three buckets used across the roster,
// contacts, batch-fill, and the gate's name picker. Single source of
// truth so a future rename (e.g. "Labour Hire" → "Sub-contractor")
// stays a one-line change instead of a 5+ file sweep. Files that
// prepend / append (e.g. auth.js gate adds "Supervision" up front)
// spread this and decorate.
const PEOPLE_GROUPS = ['Direct', 'Apprentice', 'Labour Hire'];

// Tables that get auto org_id filtering/stamping
// (used by scripts/supabase.js — _isOrgTable lives there)
const ORG_TABLES = [
  'people', 'sites', 'schedule', 'managers', 'timesheets',
  'leave_requests', 'audit_log', 'job_numbers',
  'apprentice_profiles', 'skills_ratings', 'feedback_entries',
  'rotations', 'buddy_checkins', 'quarterly_reviews', 'engagement_log',
  'roster_presence',  // v3.4.47 — realtime presence on roster editor cells
  'teams', 'team_members',  // v3.4.78 — roster filter groups
  'timesheet_locks',  // v3.4.82 — per-week timesheet lock for accounts review
  'tenders', 'tender_import_runs', 'pending_schedule',  // v3.4.85/93 — pipeline tables (org_id auto-filter)
  'prestarts', 'toolbox_talks'  // v3.10.24 — safety module
  // ── DO NOT ADD: tender_enrichment, nominations ──────────────────────────
  // These tables have no org_id column. Adding them here causes sbFetch to
  // append ?org_id=eq.UUID to GET requests → PostgREST 400 "column does not exist".
  // Security is handled by FK cascade through tenders.org_id + permissive RLS.
];

// v3.4.29: tables a tenant doesn't have. sbFetch GET on these returns []
// without making a request, killing the 404 console spam on lean tenants.
// Add a tenant key here when you spin up a new tenant; default = all enabled.
const TENANT_DISABLED_TABLES = {
  sks: [
    'apprentice_profiles', 'apprentice_journal',
    'skills_ratings', 'competencies', 'sks_quotes_materials',
    'feedback_entries', 'feedback_requests',
    'rotations', 'buddy_checkins', 'quarterly_reviews', 'engagement_log',
    'checkins'
  ]
};

// ── Group name normalisation ─────────────────────────────────
// SKS Supabase stores "SKS Direct" but the app code is hard-coded to
// filter/render by "Direct". We normalise on read and denormalise on
// write so existing Supabase rows stay compatible with the UI without
// any data migration. Populated per-tenant from TENANT_BRANDING.groupAliases.
//
// Shape: { 'SKS Direct': 'Direct' } means "on read, SKS Direct → Direct;
// on write, Direct → SKS Direct".
let GROUP_ALIAS_READ  = {};  // { dbValue: uiValue }
let GROUP_ALIAS_WRITE = {};  // { uiValue: dbValue }

function normaliseGroupFromDb(g) {
  if (!g) return '';
  return GROUP_ALIAS_READ[g] || g;
}
function denormaliseGroupForDb(g) {
  if (!g) return '';
  return GROUP_ALIAS_WRITE[g] || g;
}

async function loadTenantConfig() {
  TENANT.ORG_SLUG = _detectTenantSlug();
  // v3.4.71: earlyBootBranding() at the bottom of this file already applied
  // the static branding from DOMContentLoaded so the logo is correct from the
  // first frame. Subsequent applyTenantBranding() calls below refresh the
  // codes + org name once Supabase responds (idempotent).

  // Demo / EQ tenant — no Supabase needed
  if (TENANT.ORG_SLUG === 'demo') {
    TENANT.ORG_NAME = 'EQ Solves — Field';
    TENANT.ORG_UUID = '00000000-0000-0000-0000-000000000001';
    SB_URL          = '';
    SB_KEY          = '';
    MANAGER_PASSWORD = 'demo1234';
    applyTenantBranding();
    return;
  }

  // Live tenant — resolve Supabase credentials from TENANT_SUPABASE map
  // (falls back to window.__SB_URL__ / window.__SB_KEY__ for override/testing)
  const tConfig = TENANT_SUPABASE[TENANT.ORG_SLUG] || {};
  SB_URL = window.__SB_URL__ || tConfig.url || '';
  SB_KEY = window.__SB_KEY__ || tConfig.key || '';

  if (!SB_URL || !SB_KEY) {
    console.error('Missing Supabase config for tenant:', TENANT.ORG_SLUG);
    return;
  }

  try {
    const slug = TENANT.ORG_SLUG;
    const resp = await fetch(`${SB_URL}/rest/v1/organisations?slug=eq.${slug}&select=*`, {
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY },
      credentials: 'omit'
    });
    if (resp.ok) {
      const rows = await resp.json();
      if (rows && rows[0]) {
        TENANT.ORG_UUID = rows[0].id;
        TENANT.ORG_NAME = rows[0].name || TENANT.ORG_NAME;
      }
    }
    // Load app config (manager password etc)
    const cfgResp = await fetch(`${SB_URL}/rest/v1/app_config?org_id=eq.${TENANT.ORG_UUID}&select=key,value`, {
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY },
      credentials: 'omit'
    });
    if (cfgResp.ok) {
      const cfg = await cfgResp.json();
      let _dbStaffCode = null, _dbSupervisorCode = null;
      cfg.forEach(row => {
        if (row.key === 'manager_password')   MANAGER_PASSWORD        = row.value;
        if (row.key === 'staff_code')         _dbStaffCode            = row.value;
        if (row.key === 'supervisor_code')    _dbSupervisorCode       = row.value;
        if (row.key === 'pipeline_enabled')   TENANT.PIPELINE_ENABLED = row.value === 'true';
      });
      // Stash DB-driven access codes for applyTenantBranding to consume.
      if (_dbStaffCode || _dbSupervisorCode) {
        window.__TENANT_CODES_DB__ = {
          staff:      _dbStaffCode      || null,
          supervisor: _dbSupervisorCode || null,
        };
        console.info('EQ[tenant] Access codes loaded from Supabase app_config for', TENANT.ORG_SLUG);
      }
    }
  } catch (e) {
    console.error('loadTenantConfig error:', e);
  }
  // Apply tenant group-name aliases and fallback manager password.
  const _brand = TENANT_BRANDING[TENANT.ORG_SLUG];
  if (_brand && _brand.groupAliases) {
    GROUP_ALIAS_READ  = Object.assign({}, _brand.groupAliases);
    GROUP_ALIAS_WRITE = {};
    Object.keys(_brand.groupAliases).forEach(k => {
      GROUP_ALIAS_WRITE[_brand.groupAliases[k]] = k;
    });
  }
  if (_brand && _brand.fallbackManagerPassword && !MANAGER_PASSWORD) {
    MANAGER_PASSWORD = _brand.fallbackManagerPassword;
    console.info('EQ[tenant] Using fallback manager password for', TENANT.ORG_SLUG, '(no app_config.manager_password row)');
  }
  applyTenantBranding();

  // Show/hide pipeline nav based on app_config.pipeline_enabled
  ['nav-pipeline', 'nav-pipeline-resource'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = TENANT.PIPELINE_ENABLED ? '' : 'none';
  });
}

// Per-tenant visual branding (applied after loadTenantConfig)
const TENANT_BRANDING = {
  sks: {
    orgName: 'SKS Technologies',
    gateSub: 'NSW Labour Forecast — Staff Access',
    // Real SKS colour-arrows mark (served from Cloudflare R2 — public bucket)
    gateLogo: '<img src="https://pub-97a4f025d993484e91b8f15a8c73084d.r2.dev/SKS_Logo_Colour_Arrows_Clean.png" alt="SKS Technologies" style="height:64px;width:auto;display:block;margin:0 auto" />',
    // White-text full lockup for the dark sidebar
    sidebarLogoHtml: '<div style="display:flex;align-items:center;padding:6px 4px"><img src="https://pub-97a4f025d993484e91b8f15a8c73084d.r2.dev/SKS_Logo_White_Text_Clean.png" alt="SKS Technologies" style="height:38px;width:auto;display:block" /></div>',
    hideDemoCodes: true,
    clearDefaultName: true,
    whiteGateCard: true,
    rememberMeDays: 7,
    gateDisclaimer: 'This system stores employee names, contact details and work schedules. Access is restricted to authorised SKS Technologies staff only. Sharing this URL or access code outside the company is not permitted.',
    // Client-side access codes — validated in auth.js without hitting the
    // Netlify verify-pin function (which isn't deployed to this repo).
    // Staff code logs in with view-only access; supervisor code additionally
    // auto-unlocks Supervision mode.
    staffCode:      '2026',
    supervisorCode: 'SKSNSW',
    // Group alias map — SKS Supabase uses "SKS Direct" but the UI codes
    // "Direct" throughout. Normalised on read, denormalised on write so the
    // data layer and the UI can use different strings without a migration.
    groupAliases: { 'SKS Direct': 'Direct' },
    // Fallback supervisor password — used only if the app_config table has
    // no manager_password row for this org. Replace by inserting an
    // app_config row: { org_id: <sks-uuid>, key: 'manager_password', value: '<pw>' }
    fallbackManagerPassword: 'SKSNSW',
  },
  eq: {
    orgName: 'EQ Solves — Field',
    gateSub: 'Demo Environment',
    hideDemoCodes: false,
    clearDefaultName: false,
    whiteGateCard: false,
    rememberMeDays: 1,
    staffCode: 'demo',
    supervisorCode: 'demo1234',
    fallbackManagerPassword: 'demo1234',
  }
};

function applyTenantBranding() {
  const orgNameEl = document.getElementById('gate-org-name');
  const sidebarEl = document.getElementById('sidebar-org-name');
  if (orgNameEl) orgNameEl.textContent = TENANT.ORG_NAME;
  if (sidebarEl) sidebarEl.textContent = TENANT.ORG_SLUG.toUpperCase();

  const brand = TENANT_BRANDING[TENANT.ORG_SLUG];
  if (!brand) return;

  // Tenant class on <body> so CSS can scope overrides (e.g. `body.tenant-sks`)
  if (document && document.body) {
    document.body.classList.forEach(c => {
      if (c.indexOf('tenant-') === 0) document.body.classList.remove(c);
    });
    document.body.classList.add('tenant-' + TENANT.ORG_SLUG);
  }

  // Gate org name
  if (brand.orgName && orgNameEl) orgNameEl.textContent = brand.orgName;

  // Gate subtitle
  const gateSubEl = document.getElementById('gate-sub');
  if (brand.gateSub && gateSubEl) gateSubEl.textContent = brand.gateSub;

  // Gate logo
  const gateLogoEl = document.getElementById('gate-logo');
  if (brand.gateLogo && gateLogoEl) gateLogoEl.innerHTML = brand.gateLogo;

  // Hide demo access codes block
  if (brand.hideDemoCodes) {
    const demoCodesEl = document.getElementById('gate-demo-codes');
    if (demoCodesEl) demoCodesEl.style.display = 'none';
  }

  // Clear pre-filled "Demo Supervisor"
  if (brand.clearDefaultName) {
    const hiddenName = document.getElementById('gate-name');
    const selText = document.getElementById('gate-selected-text');
    if (hiddenName) hiddenName.value = '';
    if (selText) { selText.textContent = '— Tap to select your name —'; selText.style.color = 'var(--ink-3)'; }
  }

  // Sidebar logo swap
  const sidebarWrap = document.getElementById('sidebar-logo-wrap');
  if (brand.sidebarLogoHtml && sidebarWrap) sidebarWrap.innerHTML = brand.sidebarLogoHtml;

  // Remember-me duration label + expose TTL globally for checkPin()
  if (brand.rememberMeDays) {
    window.__TENANT_REMEMBER_DAYS__ = brand.rememberMeDays;
    const remLabel = document.getElementById('gate-remember-label');
    if (remLabel) remLabel.textContent = 'Remember me for ' + brand.rememberMeDays + ' days';
  }

  // Disclaimer footer
  if (brand.gateDisclaimer) {
    const discEl = document.getElementById('gate-disclaimer');
    if (discEl) {
      discEl.textContent = brand.gateDisclaimer;
      discEl.style.display = 'block';
    }
  }

  // White gate card styling is handled via body.tenant-sks CSS in base.css.
  // Nothing to do here for whiteGateCard — CSS does the work.

  // Expose client-side access codes to auth.js. When these are set the gate
  // validates locally instead of POSTing to /.netlify/functions/verify-pin.
  // DB values (Supabase app_config) take precedence over hardcoded brand
  // values so codes can be rotated via SQL without a redeploy.
  const _db = window.__TENANT_CODES_DB__ || {};
  const _staffCode      = _db.staff      || brand.staffCode      || null;
  const _supervisorCode = _db.supervisor || brand.supervisorCode || null;
  if (_staffCode || _supervisorCode) {
    window.__TENANT_CODES__ = {
      staff:      _staffCode,
      supervisor: _supervisorCode,
    };
  }

  // Document title
  if (brand.orgName) document.title = brand.orgName;
}

// v3.4.71: early-boot branding apply. loadTenantConfig() is async + runs from
// window.onload (after first paint), so SKS users used to see the EQ logo
// briefly before the swap. This handler fires on DOMContentLoaded (DOM parsed
// but BEFORE first paint in most browsers) and applies the static branding
// synchronously. All visible branding (logo, gate copy, body class) lives in
// the static TENANT_BRANDING map — no network call required. loadTenantConfig
// still runs at onload to load Supabase-driven access codes; applyTenantBranding
// is idempotent so the second call just refreshes those.
(function earlyBootBranding() {
  function apply() {
    try {
      TENANT.ORG_SLUG = _detectTenantSlug();
      applyTenantBranding();
    } catch (e) { /* never break boot on branding */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();

// ── App state ─────────────────────────────────────────────────
const STATE = {
  people:       [],
  sites:        [],
  schedule:     [],
  managers:     [],
  timesheets:   [],
  // v3.4.78 — Teams filter (many-to-many person↔team).
  teams:               [],   // [{id, name, color}]
  teamMembers:         [],   // [{team_id, person_id}]
  currentTeamFilter:   null, // legacy — use teamFilters (Set) instead
  teamFilters:         null, // Set of team IDs; empty/null = show all
  tsShowWeekends:      null, // null = unread; restored from localStorage in timesheets.js
  // v3.4.82 — Timesheet locks (one row per locked week).
  timesheetLocks:      [],   // [{week_key, locked_at, locked_by, reason}]
  currentWeek:  '',
  scheduleIndex: {}
};

function saveCurrentWeek() {
  try { localStorage.setItem('eq_current_week', STATE.currentWeek); } catch (e) {}
}

// Restore saved week on load
try {
  const saved = localStorage.getItem('eq_current_week');
  if (saved) STATE.currentWeek = saved;
} catch (e) {}

// ── Sort state ────────────────────────────────────────────────
let rosterSort   = { col: 'name', dir: 'asc' };
let editorSort   = 'asc';
let contactsSort = { col: 'name', dir: 'asc' };
let tsTab        = 'app';
let rosterActiveDay     = 0;
let rosterHasInteracted = false;

// ── Site colour map ───────────────────────────────────────────
const SITE_COLOR_MAP = {
  'SITE-A': 'blue',
  'SITE-B': 'green',
  'SITE-C': 'amber',
  'SITE-D': 'red',
  'SITE-E': 'purple',
  'SITE-F': 'blue',
};

// ── Leave / status codes ──────────────────────────────────────
// NOTE: TAFE and TRAINING are education, not leave — kept in a
// separate EDUCATION_TERMS list so the roster, dashboard, and
// absence panels classify them correctly.
const LEAVE_TERMS = [
  'A/L', 'AL', 'LVE', 'LEAVE', 'U/L', 'UL', 'RDO', 'PH',
  'SICK', 'JURY', 'OFF', 'DAY OFF', 'PENDING'
];

const EDUCATION_TERMS = ['TAFE', 'TRAINING'];

// ── Day arrays ────────────────────────────────────────────────
const ALL_DAYS   = ['mon','tue','wed','thu','fri','sat','sun'];
const ALL_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// ── Agency mode ───────────────────────────────────────────────
// (declared here so auth.js can reference — initialised to false)
// Note: agencyMode and agencyName are declared in auth.js

// ── Manager state ─────────────────────────────────────────────
let isManager = false;

// ── SEED DATA — Demo tenant ───────────────────────────────────
const SEED = {
  weeks: ['06.04.26','13.04.26','20.04.26','27.04.26','04.05.26'],

  managers: [
    { id:1, name:'Demo Supervisor',     role:'Operations Manager',  category:'Operations',          phone:'0400000001', email:'supervisor@eq.solutions' },
    { id:2, name:'Demo Project Manager',role:'Project Manager',     category:'Project Management',  phone:'0400000002', email:'pm@eq.solutions' },
  ],

  people: [
    // v3.4.16: DOB (day + month only) + start_date added to seed rows so
    // the demo anniversaries widget always has something to render.
    { id:1,  name:'Alex Mitchell',   group:'Direct',      phone:'0411000001', licence:'Licensed',  agency:'', email:'alex@example.com',   dob_day:28, dob_month:4, start_date:'2019-05-12' },
    { id:2,  name:'Jordan Lee',      group:'Direct',      phone:'0411000002', licence:'Licensed',  agency:'', email:'jordan@example.com', dob_day:12, dob_month:5, start_date:'2021-04-26' },
    { id:3,  name:'Sam Taylor',      group:'Direct',      phone:'0411000003', licence:'Licensed',  agency:'', email:'sam@example.com',    dob_day:4,  dob_month:5, start_date:'2020-03-02' },
    { id:4,  name:'Casey Williams',  group:'Direct',      phone:'0411000004', licence:'Licensed',  agency:'', email:'casey@example.com',  dob_day:17, dob_month:7, start_date:'2022-08-15' },
    { id:5,  name:'Morgan Davis',    group:'Direct',      phone:'0411000005', licence:'Licensed',  agency:'', email:'morgan@example.com', dob_day:3,  dob_month:1, start_date:'2018-09-10' },
    { id:6,  name:'Riley Thompson',  group:'Direct',      phone:'0411000006', licence:'Licensed',  agency:'', email:'riley@example.com',  dob_day:21, dob_month:4, start_date:'2023-02-01' },
    { id:7,  name:'Avery Johnson',   group:'Direct',      phone:'0411000007', licence:'Licensed',  agency:'', email:'avery@example.com',  dob_day:8,  dob_month:11 },
    { id:8,  name:'Blake Anderson',  group:'Direct',      phone:'0411000008', licence:'Licensed',  agency:'', email:'blake@example.com',  start_date:'2017-05-03' },
    { id:9,  name:'Drew Wilson',     group:'Direct',      phone:'0411000009', licence:'Licensed',  agency:'', email:'drew@example.com' },
    { id:10, name:'Elliot Brown',    group:'Direct',      phone:'0411000010', licence:'Licensed',  agency:'', email:'elliot@example.com' },
    { id:11, name:'Finn Clarke',     group:'Direct',      phone:'0411000011', licence:'Licensed',  agency:'', email:'finn@example.com' },
    { id:12, name:'Harper Moore',    group:'Direct',      phone:'0411000012', licence:'Licensed',  agency:'', email:'harper@example.com' },
    { id:13, name:'Indigo White',    group:'Apprentice',  phone:'0411000013', licence:'1st Year',  agency:'', email:'indigo@example.com', tafe_day:'wed', dob_day:14, dob_month:5, start_date:'2025-01-20' },
    { id:14, name:'Jamie Harris',    group:'Apprentice',  phone:'0411000014', licence:'2nd Year',  agency:'', email:'jamie@example.com',  tafe_day:'thu', dob_day:29, dob_month:4, start_date:'2024-02-12' },
    { id:15, name:'Kai Martin',      group:'Apprentice',  phone:'0411000015', licence:'3rd Year',  agency:'', email:'kai@example.com',    tafe_day:'tue' },
    { id:16, name:'Lane Robinson',   group:'Labour Hire', phone:'0411000016', licence:'Licensed',  agency:'Core Labour', email:'lane@example.com' },
    { id:17, name:'Maxine Scott',    group:'Labour Hire', phone:'0411000017', licence:'Licensed',  agency:'Core Labour', email:'maxine@example.com' },
    { id:18, name:'Noah King',       group:'Labour Hire', phone:'0411000018', licence:'Licensed',  agency:'Atom Staff',  email:'noah@example.com' },
  ],

  sites: [
    { id:1, name:'Alpha Data Centre',   abbr:'SITE-A', address:'1 Alpha Way, Industrial Area' },
    { id:2, name:'Beta Commercial Tower',abbr:'SITE-B', address:'2 Beta Street, CBD' },
    { id:3, name:'City Hospital',        abbr:'SITE-C', address:'3 City Road, Metro' },
    { id:4, name:'Delta Industrial Park',abbr:'SITE-D', address:'4 Delta Drive, West' },
    { id:5, name:'East Medical Centre',  abbr:'SITE-E', address:'5 Eastern Ave, East' },
    { id:6, name:'Foxtrot Substation',   abbr:'SITE-F', address:'6 Foxtrot Close, North' },
    { id:7, name:'Staging Area',         abbr:'STG',    address:'7 Staging Road, Depot' },
  ],

  schedule: [
    // Week 06.04.26
    { id:101, name:'Alex Mitchell',   week:'06.04.26', mon:'SITE-A', tue:'SITE-A', wed:'SITE-B', thu:'SITE-A', fri:'SITE-A' },
    { id:102, name:'Jordan Lee',      week:'06.04.26', mon:'SITE-B', tue:'SITE-B', wed:'SITE-A', thu:'SITE-B', fri:'SITE-B' },
    { id:103, name:'Sam Taylor',      week:'06.04.26', mon:'SITE-C', tue:'SITE-C', wed:'SITE-A', thu:'SITE-C', fri:'SITE-C' },
    { id:104, name:'Casey Williams',  week:'06.04.26', mon:'SITE-D', tue:'SITE-D', wed:'SITE-A', thu:'SITE-D', fri:'SITE-D' },
    { id:105, name:'Morgan Davis',    week:'06.04.26', mon:'SITE-E', tue:'SITE-E', wed:'SITE-D', thu:'SITE-E', fri:'SITE-E' },
    { id:106, name:'Riley Thompson',  week:'06.04.26', mon:'SITE-F', tue:'SITE-F', wed:'SITE-E', thu:'SITE-F', fri:'SITE-F' },
    { id:107, name:'Avery Johnson',   week:'06.04.26', mon:'SITE-A', tue:'SITE-B', wed:'SITE-F', thu:'SITE-A', fri:'SITE-A' },
    { id:108, name:'Blake Anderson',  week:'06.04.26', mon:'SITE-B', tue:'SITE-B', wed:'SITE-D', thu:'SITE-B', fri:'SITE-B' },
    { id:109, name:'Drew Wilson',     week:'06.04.26', mon:'SITE-C', tue:'SITE-C', wed:'SITE-C', thu:'SITE-C', fri:'SITE-C' },
    { id:110, name:'Elliot Brown',    week:'06.04.26', mon:'SITE-D', tue:'SITE-D', wed:'SITE-D', thu:'SITE-D', fri:'SITE-D' },
    { id:111, name:'Finn Clarke',     week:'06.04.26', mon:'SITE-E', tue:'SITE-E', wed:'SITE-A', thu:'SITE-E', fri:'SITE-E' },
    { id:112, name:'Harper Moore',    week:'06.04.26', mon:'SITE-F', tue:'SITE-F', wed:'SITE-B', thu:'SITE-F', fri:'SITE-F' },
    { id:113, name:'Indigo White',    week:'06.04.26', mon:'SITE-A', tue:'SITE-A', wed:'SITE-A', thu:'SITE-A', fri:'SITE-A' },
    { id:114, name:'Jamie Harris',    week:'06.04.26', mon:'SITE-B', tue:'SITE-B', wed:'SITE-B', thu:'SITE-B', fri:'SITE-B' },
    { id:115, name:'Kai Martin',      week:'06.04.26', mon:'SITE-C', tue:'SITE-C', wed:'SITE-C', thu:'SITE-C', fri:'SITE-C' },
    { id:116, name:'Lane Robinson',   week:'06.04.26', mon:'SITE-D', tue:'SITE-D', wed:'SITE-E', thu:'SITE-D', fri:'SITE-D' },
    { id:117, name:'Maxine Scott',    week:'06.04.26', mon:'SITE-E', tue:'SITE-E', wed:'SITE-F', thu:'SITE-E', fri:'SITE-E' },
    { id:118, name:'Noah King',       week:'06.04.26', mon:'SITE-F', tue:'SITE-F', wed:'SITE-F', thu:'SITE-F', fri:'SITE-F' },
    // Week 13.04.26
    { id:201, name:'Alex Mitchell',   week:'13.04.26', mon:'SITE-B', tue:'SITE-A', wed:'SITE-A', thu:'SITE-A', fri:'SITE-A' },
    { id:202, name:'Jordan Lee',      week:'13.04.26', mon:'SITE-B', tue:'SITE-B', wed:'SITE-B', thu:'SITE-B', fri:'SITE-B' },
    { id:203, name:'Sam Taylor',      week:'13.04.26', mon:'SITE-C', tue:'SITE-C', wed:'SITE-A', thu:'SITE-C', fri:'SITE-C' },
    { id:204, name:'Casey Williams',  week:'13.04.26', mon:'SITE-D', tue:'SITE-D', wed:'SITE-A', thu:'SITE-D', fri:'SITE-D' },
    { id:205, name:'Morgan Davis',    week:'13.04.26', mon:'SITE-E', tue:'SITE-E', wed:'SITE-D', thu:'SITE-E', fri:'SITE-E' },
    { id:206, name:'Riley Thompson',  week:'13.04.26', mon:'SITE-F', tue:'SITE-F', wed:'SITE-E', thu:'SITE-F', fri:'SITE-F' },
    { id:207, name:'Avery Johnson',   week:'13.04.26', mon:'SITE-A', tue:'SITE-A', wed:'SITE-F', thu:'SITE-A', fri:'SITE-A' },
    { id:208, name:'Blake Anderson',  week:'13.04.26', mon:'SITE-B', tue:'SITE-B', wed:'SITE-D', thu:'SITE-B', fri:'SITE-B' },
    { id:209, name:'Drew Wilson',     week:'13.04.26', mon:'SITE-C', tue:'SITE-C', wed:'SITE-C', thu:'SITE-C', fri:'SITE-C' },
    { id:210, name:'Elliot Brown',    week:'13.04.26', mon:'SITE-D', tue:'SITE-D', wed:'SITE-D', thu:'SITE-D', fri:'A/L'    },
    { id:211, name:'Finn Clarke',     week:'13.04.26', mon:'SITE-E', tue:'SITE-E', wed:'SITE-A', thu:'SITE-E', fri:'SITE-E' },
    { id:212, name:'Harper Moore',    week:'13.04.26', mon:'SITE-F', tue:'SITE-F', wed:'SITE-B', thu:'SITE-F', fri:'SITE-F' },
    { id:213, name:'Indigo White',    week:'13.04.26', mon:'SITE-A', tue:'SITE-A', wed:'SITE-A', thu:'SITE-A', fri:'SITE-A' },
    { id:214, name:'Jamie Harris',    week:'13.04.26', mon:'SITE-B', tue:'SITE-B', wed:'SITE-B', thu:'SITE-B', fri:'SITE-B' },
    { id:215, name:'Kai Martin',      week:'13.04.26', mon:'SITE-C', tue:'SITE-C', wed:'SITE-C', thu:'SITE-C', fri:'SITE-C' },
    { id:216, name:'Lane Robinson',   week:'13.04.26', mon:'SITE-D', tue:'SITE-D', wed:'SITE-E', thu:'SITE-D', fri:'SITE-D' },
    { id:217, name:'Maxine Scott',    week:'13.04.26', mon:'SITE-E', tue:'SITE-E', wed:'SITE-F', thu:'SITE-E', fri:'SITE-E' },
    { id:218, name:'Noah King',       week:'13.04.26', mon:'SITE-F', tue:'SITE-F', wed:'SITE-F', thu:'SITE-F', fri:'SITE-F' },
    // Week 20.04.26
    { id:301, name:'Alex Mitchell',   week:'20.04.26', mon:'SITE-A', tue:'SITE-A', wed:'SITE-A', thu:'SITE-A', fri:'SITE-A' },
    { id:302, name:'Jordan Lee',      week:'20.04.26', mon:'SITE-B', tue:'SITE-B', wed:'SITE-B', thu:'SITE-B', fri:'SITE-B' },
    { id:303, name:'Sam Taylor',      week:'20.04.26', mon:'SITE-C', tue:'SITE-C', wed:'SITE-C', thu:'SITE-C', fri:'SITE-C' },
    { id:304, name:'Casey Williams',  week:'20.04.26', mon:'SITE-D', tue:'SITE-D', wed:'SITE-D', thu:'SITE-D', fri:'SITE-D' },
    { id:305, name:'Morgan Davis',    week:'20.04.26', mon:'SITE-E', tue:'SITE-E', wed:'SITE-E', thu:'SITE-E', fri:'SITE-E' },
    { id:306, name:'Riley Thompson',  week:'20.04.26', mon:'SITE-F', tue:'SITE-F', wed:'SITE-F', thu:'SITE-F', fri:'SITE-F' },
    { id:307, name:'Avery Johnson',   week:'20.04.26', mon:'RDO',    tue:'SITE-A', wed:'SITE-A', thu:'SITE-A', fri:'SITE-A' },
    { id:308, name:'Blake Anderson',  week:'20.04.26', mon:'SITE-B', tue:'SITE-B', wed:'SITE-B', thu:'SITE-B', fri:'SITE-B' },
    { id:309, name:'Drew Wilson',     week:'20.04.26', mon:'SITE-C', tue:'SITE-C', wed:'SITE-C', thu:'SITE-C', fri:'SITE-C' },
    { id:310, name:'Elliot Brown',    week:'20.04.26', mon:'SITE-D', tue:'SITE-D', wed:'SITE-D', thu:'SITE-D', fri:'SITE-D' },
    { id:311, name:'Finn Clarke',     week:'20.04.26', mon:'SITE-E', tue:'SITE-E', wed:'SITE-E', thu:'SITE-E', fri:'SITE-E' },
    { id:312, name:'Harper Moore',    week:'20.04.26', mon:'SITE-F', tue:'SITE-F', wed:'SITE-F', thu:'SITE-F', fri:'SITE-F' },
    { id:313, name:'Indigo White',    week:'20.04.26', mon:'SITE-A', tue:'SITE-A', wed:'SITE-A', thu:'SITE-A', fri:'SITE-A' },
    { id:314, name:'Jamie Harris',    week:'20.04.26', mon:'SITE-B', tue:'SITE-B', wed:'SITE-B', thu:'SITE-B', fri:'SITE-B' },
    { id:315, name:'Kai Martin',      week:'20.04.26', mon:'SITE-C', tue:'SITE-C', wed:'SITE-C', thu:'SITE-C', fri:'SITE-C' },
    { id:316, name:'Lane Robinson',   week:'20.04.26', mon:'SITE-D', tue:'SITE-D', wed:'SITE-D', thu:'SITE-D', fri:'SITE-D' },
    { id:317, name:'Maxine Scott',    week:'20.04.26', mon:'SITE-E', tue:'SITE-E', wed:'SITE-E', thu:'SITE-E', fri:'SITE-E' },
    { id:318, name:'Noah King',       week:'20.04.26', mon:'SITE-F', tue:'SITE-F', wed:'SITE-F', thu:'SITE-F', fri:'SITE-F' },
  ]
};