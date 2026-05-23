/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/apprentices.js  —  EQ Solves Field  v2.3
// Apprentice Management: profiles, Skills Passport,
// tradesman feedback, self-assessment, rotations, journal.
// Depends on: app-state.js, utils.js, supabase.js
// Changes v2.0:
//   - Contacts are source of truth (year_level on people)
//   - Add Profile → Add Contact flow (no double-ups)
//   - Profile details pulled from people record
//   - Period dropdowns: Q1–Q4 current calendar year
//   - skills_ratings UPSERT (no duplicates)
//   - Rater name dropdowns: contacts + supervision list, type-to-find
//   - Feedback name: same combobox
//   - Site/Project: job numbers list + free text
// Changes v2.1 (shipped in app v3.4.5):
//   - Growth view — positive-framed QoQ sparkline on Skills Passport
//   - Follow-ups card — resolvable "things to help them with" on Overview
//   - Check-in card — gentle flag of apprentices going quiet
// Changes v2.2 (shipped in app v3.4.6):
//   - Passport default period = current quarter when available
//   - Goal presets by year on profile modal (+ free-text override)
//   - Feedback form presets on all four text fields
//   - Custom per-apprentice competencies on Skills Passport
// Changes v2.3 (shipped in app v3.4.7 — Tier 2):
//   - 3E: Apprentices can edit their own goals (year/site stay mgr-only).
//         goals_updated_at / goals_updated_by audit stamp + display.
//   - 3F: "Ask for Feedback" — apprentice picks supervisor + optional
//         prompt, fires email w/ deep link, row in feedback_requests.
//         Supervisor inbound-asks card surfaces on the apprentice list.
//   - 3G: Journal tab (scripts/journal.js) — private-default reflection
//         entries with per-entry share toggle + rotating prompts.
// ─────────────────────────────────────────────────────────────

let apprenticeProfiles = [];
let competencies = [];
let _uuidNameCache = {};
let skillsRatings = [];
let feedbackEntries = [];
let apprenticeRotations = [];
let feedbackRequests = [];        // v2.3 — Tier 2 / 3F
let apprenticeJournal = [];        // v2.3 — Tier 2 / 3G
let activeApprenticeId = null;
let activeApprenticeTab = 'overview';
let _pendingFeedbackRequestId = null; // set when a supervisor deep-links in via ?request=<id>

// ── Helpers: period ───────────────────────────────────────────

function getPeriodOptions() {
  const yr = new Date().getFullYear();
  return ['Q1 ' + yr, 'Q2 ' + yr, 'Q3 ' + yr, 'Q4 ' + yr];
}

function getCurrentPeriod() {
  const m = new Date().getMonth(); // 0-11
  const yr = new Date().getFullYear();
  const q = m < 3 ? 1 : m < 6 ? 2 : m < 9 ? 3 : 4;
  return 'Q' + q + ' ' + yr;
}

// Parse a period string 'Q1 2026' into a comparable number: year*10+q
function _periodRank(p) {
  const m = /Q(\d)\s+(\d{4})/.exec(p || '');
  if (!m) return 0;
  return parseInt(m[2], 10) * 10 + parseInt(m[1], 10);
}

// ── Self-edit gate (v2.3 — Tier 2 / 3E) ───────────────────────
// An apprentice can edit their OWN goals & journal without supervisor
// mode. A manager (supervisor) can edit any profile. staffTsPerson is
// set by auth.js on PIN login; shape: { id: <people.id UUID>, name, group }.
function canEditThisProfile(profile) {
  if (isManager) return true;
  if (!profile) return false;
  try {
    if (typeof staffTsPerson !== 'undefined' && staffTsPerson
        && String(staffTsPerson.id) === String(profile.person_id)) return true;
  } catch(_) {}
  return false;
}

function _editorDisplayName() {
  if (isManager) return (typeof currentManagerName !== 'undefined' && currentManagerName) || 'Supervisor';
  try {
    if (typeof staffTsPerson !== 'undefined' && staffTsPerson && staffTsPerson.name) return staffTsPerson.name;
  } catch(_) {}
  return 'Unknown';
}

// ── Goal suggestions by year ──────────────────────────────────
// Light-touch prompts — not a prescribed list. Apprentices can pick,
// edit, or type their own. Tone: supportive, realistic.
const YEAR_GOAL_SUGGESTIONS = {
  1: {
    tech: [
      'Learn to bend conduit accurately',
      'Terminate power and data cables confidently',
      'Get comfortable with the site induction + safety basics',
      'Identify circuit protection devices on a board',
      'Use testing equipment under supervision',
    ],
    prof: [
      'Turn up on time every day',
      'Ask questions when I\'m unsure',
      'Take notes during toolbox talks',
      'Introduce myself to everyone on the crew',
      'Own my tools and keep the van tidy',
    ],
    personal: [
      'Get through first year without burning out',
      'Start a steady morning routine',
      'Stay on top of TAFE assignments',
      'Build one good habit outside work',
    ],
  },
  2: {
    tech: [
      'Read schematics without supervision',
      'Fault-find basic circuits on my own',
      'Set out a small switchboard accurately',
      'Get comfortable with MODBUS / BMS basics on DC sites',
      'Terminate fibre under supervision',
    ],
    prof: [
      'Own my tasks end-to-end',
      'Give clear verbal updates to the supervisor',
      'Help first-years settle in',
      'Speak up when I spot an issue on site',
      'Take initiative on housekeeping',
    ],
    personal: [
      'Save up for something meaningful',
      'Keep fit — 2 sessions a week',
      'Read one book this quarter',
      'Cut screen time outside work',
    ],
  },
  3: {
    tech: [
      'Lead a small task on site',
      'Test + commission under supervisor sign-off',
      'Interpret single-line diagrams confidently',
      'Understand data-centre MOP sequencing',
      'Run a pre-start solo',
    ],
    prof: [
      'Coach a first-year through a task',
      'Run my own daily task list',
      'Chair a pre-start when the leading hand is off site',
      'Push back respectfully when a scope is unclear',
      'Build relationships across trades on site',
    ],
    personal: [
      'Hit a savings goal',
      'Plan a trip for end of year',
      'Pick up a hobby outside the trade',
      'Improve sleep routine',
    ],
  },
  4: {
    tech: [
      'Commission + test independently',
      'Produce site test reports',
      'Lead a full scope of works on a small package',
      'Mentor 1st + 2nd years through TAFE topics',
      'Write a MOP under the PM\'s guidance',
    ],
    prof: [
      'Sit my capstone / final exam with confidence',
      'Prepare a tradesman-level CV',
      'Present work to a supervisor or client',
      'Talk through next steps after trade with someone I trust',
      'Mentor someone newer than me',
    ],
    personal: [
      'Plan post-trade next step — tradesman, contractor, further study',
      'Hit savings target',
      'Balance TAFE + work + life through final year',
      'Book something in to celebrate finishing',
    ],
  },
};

// Rebuild the three goal-suggestion selects for the current year level.
// Called whenever the ap-year select changes, and when the modal opens.
function refreshGoalSuggestions() {
  const yearEl = document.getElementById('ap-year');
  if (!yearEl) return;
  const year = parseInt(yearEl.value, 10) || 1;
  const set = YEAR_GOAL_SUGGESTIONS[year] || YEAR_GOAL_SUGGESTIONS[1];
  const wire = (selectId, axis) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    let html = '<option value="">Pick an example…</option>';
    (set[axis] || []).forEach(g => {
      html += '<option value="' + esc(g) + '">' + esc(g) + '</option>';
    });
    html += '<option value="__own">✏️ Type my own</option>';
    sel.innerHTML = html;
    sel.value = '';
  };
  wire('ap-goal-tech-suggest', 'tech');
  wire('ap-goal-prof-suggest', 'prof');
  wire('ap-goal-personal-suggest', 'personal');
}

// When a suggestion is picked, fill the matching textarea.
// "__own" just focuses the textarea so they can type their own.
function applyGoalSuggestion(axis) {
  const selectId = 'ap-goal-' + axis + '-suggest';
  const textareaId = 'ap-goal-' + axis;
  const sel = document.getElementById(selectId);
  const ta = document.getElementById(textareaId);
  if (!sel || !ta) return;
  const v = sel.value;
  if (v === '__own') {
    ta.focus();
  } else if (v) {
    ta.value = v;
  }
  sel.value = '';
}

// ── Feedback suggestion presets ───────────────────────────────
// Not prescriptive — prompts that take a blank page and turn it
// into something a supervisor can click, edit, or write over.
const FEEDBACK_SUGGESTIONS = {
  didWell: [
    'Stayed calm under pressure',
    'Asked good questions before starting',
    'Kept the work area tidy all day',
    'Picked up a new tool quickly',
    'Communicated well with other trades',
    'Checked their own work before moving on',
    'Owned a mistake and fixed it',
    'Helped a team-mate without being asked',
  ],
  trustNext: [
    'Running a small pre-start on their own',
    'Taking the lead on a simple install',
    'Testing + tagging a circuit under sign-off',
    'Cable pulling without step-by-step direction',
    'Interpreting schematics on a small scope',
    'Mentoring a newer apprentice on basics',
  ],
  needsImprove: [
    'Speed on repetitive tasks',
    'Tool housekeeping at day end',
    'Asking for help before going too far wrong',
    'Reading schematics independently',
    'Site-safety awareness around other trades',
    'Double-checking before signing off',
  ],
  followUp: [
    'Book a 10-min 1:1 on next site visit',
    'Show them the test procedure again',
    'Pair them with a 3rd year for a week',
    'Check in at next TAFE week',
    'Review with leading hand on Friday',
    'Send the cheat-sheet for this task',
  ],
};

// Rebuild the four feedback-suggestion selects with their static options.
// Called once, when the feedback modal opens.
function wireFeedbackSuggestions() {
  const map = [
    ['fb-did-well-suggest', 'didWell'],
    ['fb-trust-next-suggest', 'trustNext'],
    ['fb-needs-improve-suggest', 'needsImprove'],
    ['fb-follow-up-suggest', 'followUp'],
  ];
  map.forEach(pair => {
    const sel = document.getElementById(pair[0]);
    if (!sel) return;
    let html = '<option value="">Pick a suggestion…</option>';
    (FEEDBACK_SUGGESTIONS[pair[1]] || []).forEach(s => {
      html += '<option value="' + esc(s) + '">' + esc(s) + '</option>';
    });
    html += '<option value="__own">✏️ Type my own</option>';
    sel.innerHTML = html;
    sel.value = '';
  });
}

// When a feedback suggestion is picked, fill the matching textarea/input.
// Argument is the target element's id (e.g. 'fb-did-well'); the paired
// select is that id + '-suggest'. "__own" just focuses the target.
function applyFeedbackSuggestion(fieldId) {
  const sel = document.getElementById(fieldId + '-suggest');
  const target = document.getElementById(fieldId);
  if (!sel || !target) return;
  const v = sel.value;
  if (v === '__own') {
    target.focus();
  } else if (v) {
    target.value = v;
  }
  sel.value = '';
}

// ── Per-apprentice custom competencies ────────────────────────
// Stored on apprentice_profiles.custom_competencies (JSONB array of
// {id, name}). Ratings for custom comps live on
// apprentice_profiles.custom_ratings (JSONB object keyed by comp id).
// This keeps the global competencies catalog clean across tenants
// and avoids FK constraints on skills_ratings.

function getCustomCompetencies(profile) {
  if (!profile) return [];
  const raw = profile.custom_competencies;
  return Array.isArray(raw) ? raw : [];
}

function getCustomRatings(profile) {
  if (!profile) return {};
  const raw = profile.custom_ratings;
  return (raw && typeof raw === 'object') ? raw : {};
}

// Merge standard + custom comps for a given profile. Standard comps
// keep their shape (numeric id, name). Custom comps come with string
// ids (e.g. "custom_1712345678") and a _custom flag for render hooks.
function getEffectiveCompetencies(profile) {
  const std = competencies.slice();
  const custom = getCustomCompetencies(profile).map(c => ({
    id: c.id,
    name: c.name,
    _custom: true,
  }));
  return std.concat(custom);
}

// Read a custom-comp rating for a given period + type ('self'|'tradesman').
function getCustomRating(profile, compId, type, period) {
  const all = getCustomRatings(profile);
  const bucket = all[compId];
  if (!bucket) return null;
  const key = type === 'self' ? 'self' : 'trade';
  const periodMap = bucket[key] || {};
  return typeof periodMap[period] === 'number' ? periodMap[period] : null;
}

// Add a new custom competency. Prompts for a name, PATCHes profile,
// refreshes UI. String id derived from timestamp + random nibble.
async function addCustomCompetency(profileId) {
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile) return;
  const name = (prompt('Add a custom skill for this apprentice:\n(e.g. Thermal scanning, Rack termination, Site induction)') || '').trim();
  if (!name) return;

  const list = getCustomCompetencies(profile).slice();
  if (list.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    showToast('That skill already exists on this passport');
    return;
  }
  const id = 'custom_' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
  list.push({ id, name });

  try {
    await sbFetch('apprentice_profiles?id=eq.' + profileId, 'PATCH', {
      custom_competencies: list,
      updated_at: new Date().toISOString(),
    });
    profile.custom_competencies = list;
    showToast('Added ✓');
    renderApprenticeProfile(profileId);
  } catch(e) {
    showToast('Save failed — check connection');
  }
}

// Remove a custom comp and any ratings tied to it. Confirms first.
async function removeCustomCompetency(profileId, compId) {
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile) return;
  const list = getCustomCompetencies(profile);
  const entry = list.find(c => String(c.id) === String(compId));
  if (!entry) return;
  if (!confirm('Remove "' + entry.name + '" from this passport? Ratings for this skill will be cleared.')) return;

  const newList = list.filter(c => c.id !== compId);
  const newRatings = Object.assign({}, getCustomRatings(profile));
  delete newRatings[compId];

  try {
    await sbFetch('apprentice_profiles?id=eq.' + profileId, 'PATCH', {
      custom_competencies: newList,
      custom_ratings: newRatings,
      updated_at: new Date().toISOString(),
    });
    profile.custom_competencies = newList;
    profile.custom_ratings = newRatings;
    showToast('Removed ✓');
    renderApprenticeProfile(profileId);
  } catch(e) {
    showToast('Save failed — check connection');
  }
}

// CSS-safe attribute value — custom ids contain only [a-z0-9_], and
// numeric ids from standard comps are obviously fine, but a guard
// never hurts. Used to build attribute selectors for the rating grids.
function _compAttr(id) {
  return String(id).replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function periodSelectHtml(id, selected) {
  const opts = getPeriodOptions();
  let h = '<select id="' + id + '" style="width:100%;padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px;background:var(--surface);color:var(--ink)">';
  opts.forEach(o => {
    h += '<option value="' + o + '"' + (o === (selected || getCurrentPeriod()) ? ' selected' : '') + '>' + o + '</option>';
  });
  h += '</select>';
  return h;
}

// ── Helpers: people/contacts combobox ────────────────────────

function nameComboHtml(id, placeholder, value) {
  // Datalist of all people (direct + supervision/managers) + free text
  const allPeople = [];
  (STATE.people || []).forEach(p => allPeople.push(p.name));
  (STATE.managers || []).forEach(m => { if (!allPeople.includes(m.name)) allPeople.push(m.name); });
  allPeople.sort();

  let h = '<input id="' + id + '" list="' + id + '-list" autocomplete="off" placeholder="' + (placeholder || 'Type to search or enter name') + '" value="' + esc(value || '') + '" style="width:100%;padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px;background:var(--surface);color:var(--ink);box-sizing:border-box">';
  h += '<datalist id="' + id + '-list">';
  allPeople.forEach(n => { h += '<option value="' + esc(n) + '">'; });
  h += '</datalist>';
  return h;
}

// ── Helpers: job number combobox ──────────────────────────────

function jobComboHtml(id, placeholder, value) {
  // jobNumbers is the module-level array from scripts/jobnumbers.js
  const jobs = (typeof jobNumbers !== 'undefined' ? jobNumbers : null) || STATE.jobNumbers || STATE.job_numbers || [];
  let h = '<input id="' + id + '" list="' + id + '-list" autocomplete="off" placeholder="' + (placeholder || 'Job number or project name') + '" value="' + esc(value || '') + '" style="width:100%;padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px;background:var(--surface);color:var(--ink);box-sizing:border-box">';
  h += '<datalist id="' + id + '-list">';
  jobs.forEach(j => {
    const label = (j.number || j.job_number || '') + (j.description ? ' — ' + j.description : '') + (j.site_name ? ' (' + j.site_name + ')' : '');
    h += '<option value="' + esc(label) + '">';
  });
  h += '</datalist>';
  return h;
}

// ── Data loading ──────────────────────────────────────────────

async function loadApprenticeData() {
  try {
    const [profiles, comps, ratings, feedback, rots, dbPeople, fbReqs, journal] = await Promise.all([
      sbFetch('apprentice_profiles?order=id.asc'),
      sbFetch('competencies?order=sort_order.asc&active=eq.true'),
      sbFetch('skills_ratings?order=period.asc,rating_type.asc,competency_id.asc'),
      sbFetch('feedback_entries?order=feedback_date.desc'),
      sbFetch('rotations?order=date_start.desc'),
      sbFetch('people?select=id,name,year_level,licence,group&order=name.asc'),
      // v2.3: Tier 2 tables — absent on older tenants so swallow failure
      sbFetch('feedback_requests?order=created_at.desc').catch(() => []),
      sbFetch('apprentice_journal?order=entry_date.desc').catch(() => []),
    ]);

    // Build UUID→name + UUID→year_level lookups.
    // v3.4.10: if year_level isn't populated yet, fall back to parsing
    // licence (which the Add Person modal writes as '2nd Year' etc.).
    // This keeps legacy apprentice rows showing the right year until
    // the EQ demo backfill migration reaches them.
    const uuidToName = {};
    const uuidToYear = {};
    const parseLicenceYear = (s) => {
      if (!s) return null;
      const m = String(s).trim().match(/^([1-4])(?:st|nd|rd|th)\s+Year$/i);
      return m ? parseInt(m[1], 10) : null;
    };
    if (dbPeople && dbPeople.length) {
      dbPeople.forEach(p => {
        uuidToName[String(p.id)] = p.name;
        const y = p.year_level || parseLicenceYear(p.licence);
        if (y) uuidToYear[String(p.id)] = y;
      });
    }
    if (typeof STATE !== 'undefined' && STATE.people) {
      STATE.people.forEach(p => { uuidToName[String(p.name)] = p.name; });
    }
    _uuidNameCache = { ...uuidToName };

    if (profiles) {
      apprenticeProfiles = profiles.map(p => ({
        ...p,
        _resolvedName: uuidToName[String(p.person_id)] || null,
        _resolvedYear: uuidToYear[String(p.person_id)] || p.year_level || null,
      }));
    }
    if (comps && comps.length) competencies = comps;
    if (ratings) skillsRatings = ratings;
    if (feedback) feedbackEntries = feedback;
    if (rots) apprenticeRotations = rots;
    if (fbReqs) feedbackRequests = fbReqs;
    if (journal) apprenticeJournal = journal;
  } catch (e) {
    console.warn('EQ[apprentices] load failed:', e && e.message || e);
  }
}

// ── Name resolver ─────────────────────────────────────────────

function getPersonNameById(personId) {
  const seed = (STATE.people || []).find(x => x.id === personId || String(x.id) === String(personId));
  if (seed) return seed.name;
  const prof = apprenticeProfiles.find(x => String(x.person_id) === String(personId));
  if (prof && prof._resolvedName) return prof._resolvedName;
  return _uuidNameCache[String(personId)] || 'Unknown';
}

// ── Year badge ────────────────────────────────────────────────

function yearBadge(year) {
  const labels = { 1: '1st Year', 2: '2nd Year', 3: '3rd Year', 4: '4th Year' };
  const colors = {
    1: '#EFF4FF;color:#2563EB',
    2: '#F0FDF4;color:#16A34A',
    3: '#FFFBEB;color:#D97706',
    4: '#EEEDF8;color:#7C77B9'
  };
  return '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:' + (colors[year] || '#F8FAFC;color:#64748B') + '">' + (labels[year] || (year + 'th Year')) + '</span>';
}

// Accepts either a profile object or an apprentice id. When a profile
// object is given, custom-comp ratings (stored on the profile JSON)
// are included in the average. When only an id is given, custom
// ratings are skipped — used in hot paths that don't need the blend.
function avgRating(profileOrId, type) {
  let apprenticeId, profile;
  if (profileOrId && typeof profileOrId === 'object') {
    profile = profileOrId;
    apprenticeId = profile.id;
  } else {
    apprenticeId = profileOrId;
    profile = apprenticeProfiles.find(p => String(p.id) === String(apprenticeId)) || null;
  }

  const ratings = skillsRatings
    .filter(r => r.apprentice_id === apprenticeId && r.rating_type === type)
    .map(r => r.rating);

  // Pull custom ratings (latest value per comp) for the same type.
  if (profile) {
    const key = type === 'self' ? 'self' : 'trade';
    const all = getCustomRatings(profile);
    Object.keys(all).forEach(compId => {
      const periodMap = (all[compId] || {})[key] || {};
      // Use most recent by period rank, matching how the passport
      // defaults to the current/latest period.
      const periods = Object.keys(periodMap);
      if (!periods.length) return;
      periods.sort((a, b) => _periodRank(a) - _periodRank(b));
      const latest = periodMap[periods[periods.length - 1]];
      if (typeof latest === 'number') ratings.push(latest);
    });
  }

  if (!ratings.length) return null;
  return (ratings.reduce((s, v) => s + v, 0) / ratings.length).toFixed(1);
}

function ratingColor(r) {
  if (!r) return 'var(--ink-4)';
  if (r <= 2) return '#DC2626';
  if (r <= 3) return '#D97706';
  return '#16A34A';
}

function ratingBg(r) {
  if (!r) return '#F8FAFC';
  if (r <= 2) return '#FEF2F2';
  if (r <= 3) return '#FFFBEB';
  return '#F0FDF4';
}

function starDisplay(rating) {
  if (!rating) return '<span style="color:var(--ink-4);font-size:13px">—</span>';
  const full = Math.round(rating);
  return Array.from({ length: 5 }, (_, i) =>
    '<span style="color:' + (i < full ? '#F59E0B' : '#E5E7EB') + ';font-size:16px">★</span>'
  ).join('');
}

// ── Check-in signal helpers (v2.1) ────────────────────────────
// Keep it simple: three cheap checks against already-loaded data.
// Designed to nudge supervisors, not admin-ify anything.

function _daysSince(isoOrDateStr) {
  if (!isoOrDateStr) return Infinity;
  const d = new Date(isoOrDateStr + (isoOrDateStr.length === 10 ? 'T00:00:00' : ''));
  if (isNaN(d.getTime())) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// Returns reasons (array of strings) this apprentice could use a check-in.
// Empty array = doing fine.
function checkInReasonsFor(profileId) {
  const reasons = [];

  // 1. No self-rating this quarter — only fires after the first 30 days of
  //    the quarter, so we're not nagging people on 1 July.
  const now = new Date();
  const m = now.getMonth();
  const qStartMonth = (m < 3 ? 0 : m < 6 ? 3 : m < 9 ? 6 : 9);
  const qStart = new Date(now.getFullYear(), qStartMonth, 1);
  const daysIntoQuarter = Math.floor((now - qStart) / 86400000);
  if (daysIntoQuarter >= 30) {
    const thisPeriod = getCurrentPeriod();
    const hasSelfThisQ = skillsRatings.some(r =>
      r.apprentice_id === profileId && r.rating_type === 'self' && r.period === thisPeriod
    );
    if (!hasSelfThisQ) reasons.push('No self-rating yet this quarter');
  }

  // 2. No feedback in 60+ days
  const theirFeedback = feedbackEntries.filter(f => f.apprentice_id === profileId);
  if (theirFeedback.length === 0) {
    reasons.push('No feedback recorded yet');
  } else {
    const mostRecent = theirFeedback.reduce((best, f) => {
      const d = _daysSince(f.feedback_date);
      return d < best ? d : best;
    }, Infinity);
    if (mostRecent >= 60) reasons.push('No feedback in ' + mostRecent + ' days');
  }

  // 3. Open follow-up older than 30 days
  const staleFollowUp = feedbackEntries.find(f =>
    f.apprentice_id === profileId &&
    f.follow_up &&
    !f.resolved_at &&
    _daysSince(f.feedback_date) >= 30
  );
  if (staleFollowUp) reasons.push('Open follow-up from ' + staleFollowUp.feedback_date);

  return reasons;
}

// ── Main list render ──────────────────────────────────────────

function renderApprentices() {
  const container = document.getElementById('apprentices-content');
  if (!container) return;

  if (activeApprenticeId) {
    renderApprenticeProfile(activeApprenticeId);
    return;
  }

  const apprenticePeople = (STATE.people || []).filter(p => p.group === 'Apprentice');

  if (!apprenticePeople.length) {
    container.innerHTML = '<div class="empty"><div class="empty-icon">🎓</div><p>No apprentices on the roster yet</p>' +
      (isManager ? '<button class="btn btn-primary" style="margin-top:12px" onclick="openAddContact()">+ Add Contact</button>' : '') +
      '</div>';
    return;
  }

  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
  html += '<div><div class="section-title">Apprentice Management</div><div style="font-size:12px;color:var(--ink-3);margin-top:3px">Skills tracking, feedback and development</div></div>';
  if (isManager) {
    html += '<button class="btn btn-primary btn-sm" onclick="openAddContact()">+ Add Contact</button>';
  }
  html += '</div>';

  // Check-in card (manager-only, only if at least one apprentice has reasons)
  if (isManager) {
    html += renderInboundAsksCard();
    html += renderCheckInCard(apprenticePeople);
  }

  html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">';

  apprenticePeople.forEach(person => {
    const profile = apprenticeProfiles.find(p =>
      String(p.person_id) === String(person.id) || p._resolvedName === person.name
    );
    const selfAvg = profile ? avgRating(profile, 'self') : null;
    const tradeAvg = profile ? avgRating(profile, 'tradesman') : null;
    const feedbackCount = profile ? feedbackEntries.filter(f => f.apprentice_id === profile.id).length : 0;
    // Year level from contact (source of truth) or profile fallback
    const yearLevel = person.year_level || (profile && profile.year_level);

    html += '<div class="roster-card" style="padding:18px 20px;cursor:pointer;transition:box-shadow .15s" onclick="openApprenticeProfile(' + (profile ? profile.id : 'null') + ',\'' + esc(person.name) + '\')" onmouseover="this.style.boxShadow=\'0 4px 16px rgba(0,0,0,.12)\'" onmouseout="this.style.boxShadow=\'\'">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
    html += '<div><div style="font-size:15px;font-weight:700;color:var(--navy)">' + esc(person.name) + '</div>';
    html += '<div style="margin-top:4px">' + (yearLevel ? yearBadge(yearLevel) : '<span style="font-size:10px;color:var(--ink-4)">Year not set</span>') + '</div></div>';
    html += '<div style="font-size:32px">🎓</div>';
    html += '</div>';

    if (profile) {
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">';
      html += '<div style="background:var(--surface-2);border-radius:8px;padding:8px 10px;text-align:center">';
      html += '<div style="font-size:10px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Self</div>';
      html += '<div style="font-size:18px;font-weight:800;color:' + ratingColor(selfAvg) + '">' + (selfAvg || '—') + '</div></div>';
      html += '<div style="background:var(--surface-2);border-radius:8px;padding:8px 10px;text-align:center">';
      html += '<div style="font-size:10px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Tradesman</div>';
      html += '<div style="font-size:18px;font-weight:800;color:' + ratingColor(tradeAvg) + '">' + (tradeAvg || '—') + '</div></div>';
      html += '</div>';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--ink-3);padding-top:10px;border-top:1px solid var(--border)">';
      html += '<span>' + feedbackCount + ' feedback ' + (feedbackCount === 1 ? 'entry' : 'entries') + '</span>';
      html += '<span style="color:var(--purple);font-weight:600">View Profile →</span>';
      html += '</div>';
    } else {
      html += '<div style="font-size:12px;color:var(--ink-3);margin-bottom:8px">No skills profile yet</div>';
      if (isManager) {
        html += '<div style="font-size:11px;color:var(--purple);font-weight:600">Click to set up →</div>';
      }
    }
    html += '</div>';
  });

  html += '</div>';
  container.innerHTML = html;
}

// ── Inbound asks card (v2.3 / 3F) ─────────────────────────────
// When a supervisor is in manager mode AND has incoming feedback
// requests addressed to them (by name match), show them as tappable
// cards that open the feedback form with the request bound.

function renderInboundAsksCard() {
  const inbox = getInboundRequestsForSupervisor(currentManagerName);
  if (!inbox.length) return '';

  let html = '<div class="roster-card" style="padding:16px 20px;margin-bottom:16px;background:linear-gradient(135deg,#EEF2FF 0%,#E0E7FF 100%);border-left:4px solid #6B5BD6">';
  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">';
  html += '<div style="font-size:22px">💬</div>';
  html += '<div>';
  html += '<div style="font-size:13px;font-weight:700;color:var(--navy)">Apprentices asking for your feedback</div>';
  html += '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">Tap one to leave a short note — no pressure, whenever you\'re ready.</div>';
  html += '</div></div>';

  html += '<div style="display:flex;flex-wrap:wrap;gap:8px">';
  inbox.forEach(req => {
    const when = new Date(req.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    const promptPreview = req.prompt ? (req.prompt.length > 60 ? req.prompt.slice(0, 60) + '…' : req.prompt) : 'General check-in';
    const profile = apprenticeProfiles.find(p => String(p.id) === String(req.apprentice_id));
    if (!profile) return;
    const name = getPersonNameById(profile.person_id);
    html += '<button onclick="openFeedbackForm(' + profile.id + ',\'' + esc(name) + '\',\'' + esc(req.id) + '\')" style="background:white;border:1px solid #C7D2FE;border-radius:10px;padding:10px 14px;text-align:left;cursor:pointer;font-family:inherit;min-width:220px;transition:transform .1s" onmouseover="this.style.transform=\'translateY(-1px)\'" onmouseout="this.style.transform=\'\'">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px"><div style="font-size:13px;font-weight:700;color:var(--navy)">' + esc(name) + '</div><div style="font-size:10px;color:var(--ink-3)">' + when + '</div></div>';
    html += '<div style="font-size:11px;color:var(--ink-2);line-height:1.4">' + esc(promptPreview) + '</div>';
    html += '</button>';
  });
  html += '</div>';
  html += '</div>';
  return html;
}

// ── Check-in card (v2.1) ──────────────────────────────────────
// Gentle manager-only nudge. If no apprentice has any signal, the
// card doesn't render at all (keeps the view clean most days).

function renderCheckInCard(apprenticePeople) {
  const flagged = [];
  apprenticePeople.forEach(person => {
    const profile = apprenticeProfiles.find(p =>
      String(p.person_id) === String(person.id) || p._resolvedName === person.name
    );
    if (!profile) return; // no profile yet — handled elsewhere
    const reasons = checkInReasonsFor(profile.id);
    if (reasons.length) flagged.push({ person, profile, reasons });
  });

  if (!flagged.length) return '';

  let html = '<div class="roster-card" style="padding:16px 20px;margin-bottom:16px;background:linear-gradient(135deg,#FFFBEB 0%,#FEF3C7 100%);border-left:4px solid #D97706">';
  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">';
  html += '<div style="font-size:22px">☕</div>';
  html += '<div>';
  html += '<div style="font-size:13px;font-weight:700;color:var(--navy)">Who could use a quick check-in?</div>';
  html += '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">A 5-minute chat goes a long way — these apprentices have gone a bit quiet.</div>';
  html += '</div></div>';

  html += '<div style="display:flex;flex-wrap:wrap;gap:8px">';
  flagged.forEach(f => {
    const reasonText = f.reasons.join(' · ');
    html += '<button onclick="openApprenticeProfile(' + f.profile.id + ',\'' + esc(f.person.name) + '\')" style="background:white;border:1px solid #FDE68A;border-radius:10px;padding:10px 14px;text-align:left;cursor:pointer;font-family:inherit;min-width:200px;transition:transform .1s" onmouseover="this.style.transform=\'translateY(-1px)\'" onmouseout="this.style.transform=\'\'">';
    html += '<div style="font-size:13px;font-weight:700;color:var(--navy);margin-bottom:2px">' + esc(f.person.name) + '</div>';
    html += '<div style="font-size:11px;color:var(--ink-3);line-height:1.4">' + esc(reasonText) + '</div>';
    html += '</button>';
  });
  html += '</div>';
  html += '</div>';
  return html;
}

// ── Open profile (or redirect to Add Contact) ─────────────────

function openApprenticeProfile(profileId, personName) {
  if (!profileId) {
    if (isManager) {
      // No profile — guide to set up profile (contact already exists)
      openSetupProfile(personName);
    } else {
      showToast('No profile set up yet for ' + personName);
    }
    return;
  }
  activeApprenticeId = profileId;
  activeApprenticeTab = 'overview';
  renderApprenticeProfile(profileId);
}

function renderApprenticeProfile(profileId) {
  const container = document.getElementById('apprentices-content');
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile || !container) return;

  const person = (STATE.people || []).find(p =>
    String(p.id) === String(profile.person_id) || p.name === profile._resolvedName
  );
  const personName = person ? person.name : (profile._resolvedName || 'Unknown');
  // Year from contact (source of truth)
  const yearLevel = (person && person.year_level) || profile._resolvedYear || profile.year_level;
  const site = (STATE.sites || []).find(s => s.abbr === profile.current_site);

  let html = '<div style="margin-bottom:16px">';
  html += '<button class="btn btn-secondary btn-sm" onclick="closeApprenticeProfile()" style="margin-bottom:14px">← All Apprentices</button>';
  html += '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">';
  html += '<div style="font-size:40px">🎓</div>';
  html += '<div>';
  html += '<div style="font-size:20px;font-weight:800;color:var(--navy)">' + esc(personName) + '</div>';
  html += '<div style="display:flex;gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap">';
  if (yearLevel) html += yearBadge(yearLevel);
  if (profile.current_site) html += '<span style="font-size:11px;color:var(--ink-3)">📍 ' + esc(site ? site.name : profile.current_site) + '</span>';
  if (profile.start_date) html += '<span style="font-size:11px;color:var(--ink-3)">📅 Started ' + profile.start_date + '</span>';
  html += '</div></div></div>';

  // Tabs
  const fbCount = feedbackEntries.filter(f => f.apprentice_id === profileId).length;
  const isSelfView = (typeof staffTsPerson !== 'undefined' && staffTsPerson
      && String(staffTsPerson.id) === String(profile.person_id));
  // Journal entry count — apprentice sees all their own, manager sees only shared
  let journalCount = 0;
  if (typeof apprenticeJournal !== 'undefined') {
    journalCount = apprenticeJournal.filter(j =>
      j.apprentice_id === profileId && (isSelfView || j.shared)).length;
  }
  const tabs = [
    { id: 'overview', label: '👤 Overview' },
    { id: 'passport', label: '🎯 Skills Passport' },
    { id: 'feedback', label: '💬 Feedback (' + fbCount + ')' },
    { id: 'journal', label: '📓 Journal' + (journalCount ? ' (' + journalCount + ')' : '') },
    { id: 'rotations', label: '🏗 Rotations' },
  ];
  html += '<div style="display:flex;gap:4px;margin-top:16px;border-bottom:2px solid var(--border);padding-bottom:0">';
  tabs.forEach(t => {
    const active = activeApprenticeTab === t.id;
    html += '<button onclick="setApprenticeTab(' + profileId + ',\'' + t.id + '\')" style="padding:9px 16px;border:none;background:none;font-family:inherit;font-size:12px;font-weight:' + (active ? '700' : '500') + ';color:' + (active ? 'var(--navy)' : 'var(--ink-3)') + ';cursor:pointer;border-bottom:2px solid ' + (active ? 'var(--navy)' : 'transparent') + ';margin-bottom:-2px">' + t.label + '</button>';
  });
  html += '</div></div>';

  if (activeApprenticeTab === 'overview') html += renderApprenticeOverviewTab(profile, personName, person);
  else if (activeApprenticeTab === 'passport') html += renderSkillsPassportTab(profile);
  else if (activeApprenticeTab === 'feedback') html += renderFeedbackTab(profile, personName);
  else if (activeApprenticeTab === 'journal' && typeof renderApprenticeJournalTab === 'function') html += renderApprenticeJournalTab(profile, personName);
  else if (activeApprenticeTab === 'rotations') html += renderRotationsTab(profile);

  container.innerHTML = html;
}

function setApprenticeTab(profileId, tab) {
  activeApprenticeTab = tab;
  renderApprenticeProfile(profileId);
}

function closeApprenticeProfile() {
  activeApprenticeId = null;
  activeApprenticeTab = 'overview';
  renderApprentices();
}

// ── Overview tab ──────────────────────────────────────────────

function renderApprenticeOverviewTab(profile, personName, person) {
  const yearLevel = (person && person.year_level) || profile._resolvedYear || profile.year_level;
  let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">';

  // Goals card
  html += '<div class="roster-card" style="padding:18px 20px;grid-column:1/-1">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">';
  html += '<div style="font-size:13px;font-weight:700;color:var(--navy)">Development Goals</div>';
  if (canEditThisProfile(profile)) {
    const goalsBtnLabel = (!isManager && staffTsPerson && String(staffTsPerson.id) === String(profile.person_id))
      ? 'Edit My Goals' : 'Edit Goals';
    html += '<button class="btn btn-secondary btn-sm" onclick="openEditGoals(' + profile.id + ')">' + goalsBtnLabel + '</button>';
  }
  html += '</div>';
  html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">';
  const goals = [
    { label: '🔧 Technical', val: profile.goal_technical },
    { label: '💼 Professional', val: profile.goal_professional },
    { label: '🌱 Personal', val: profile.goal_personal },
  ];
  goals.forEach(g => {
    html += '<div style="background:var(--surface-2);border-radius:8px;padding:12px 14px">';
    html += '<div style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">' + g.label + '</div>';
    html += '<div style="font-size:12px;color:var(--ink-2);line-height:1.5">' + (g.val ? esc(g.val) : '<span style="color:var(--ink-4)">Not set yet</span>') + '</div>';
    html += '</div>';
  });
  html += '</div>';
  // Audit line — only render if we have an updated stamp
  if (profile.goals_updated_at) {
    const auditDate = new Date(profile.goals_updated_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    html += '<div style="font-size:10px;color:var(--ink-4);margin-top:10px;text-align:right">Last edited by ' + esc(profile.goals_updated_by || 'someone') + ' · ' + auditDate + '</div>';
  }
  html += '</div>';

  // Pending feedback asks (v2.3 / 3F) — shown to apprentice + supervisor
  html += renderPendingRequestsCard(profile, personName);

  // Follow-ups card (v2.1) — only shows if there's something to resolve
  html += renderFollowUpsCard(profile, personName);

  // Details card — from contact record
  html += '<div class="roster-card" style="padding:18px 20px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">';
  html += '<div style="font-size:13px;font-weight:700;color:var(--navy)">Contact Details</div>';
  if (isManager) html += '<button class="btn btn-secondary btn-sm" onclick="openEditContactYear(\'' + esc(personName) + '\',' + profile.id + ')">Edit</button>';
  html += '</div>';
  const details = [
    ['Year Level', yearLevel ? yearBadge(yearLevel) : '<span style="color:var(--ink-4)">Not set</span>'],
    ['Phone', (person && person.phone) || '—'],
    ['Email', (person && person.email) || '—'],
    ['Start Date', profile.start_date || '—'],
    ['Current Site', profile.current_site || '—'],
    ['Active', profile.active ? '✅ Yes' : '❌ No'],
  ];
  details.forEach(([label, val]) => {
    html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">';
    html += '<span style="color:var(--ink-3)">' + label + '</span><span style="font-weight:600">' + val + '</span>';
    html += '</div>';
  });
  if (profile.notes) html += '<div style="margin-top:12px;font-size:12px;color:var(--ink-2);background:var(--surface-2);padding:10px 12px;border-radius:6px;line-height:1.5">' + esc(profile.notes) + '</div>';
  html += '</div>';

  // At a glance
  const selfAvg = avgRating(profile, 'self');
  const tradeAvg = avgRating(profile, 'tradesman');
  const fbCount = feedbackEntries.filter(f => f.apprentice_id === profile.id).length;
  const rotCount = apprenticeRotations.filter(r => r.apprentice_id === profile.id).length;
  html += '<div class="roster-card" style="padding:18px 20px">';
  html += '<div style="font-size:13px;font-weight:700;color:var(--navy);margin-bottom:14px">At a Glance</div>';
  [['Self Rating', selfAvg ? selfAvg + ' / 5' : 'Not rated', ratingColor(selfAvg)],
   ['Trade Rating', tradeAvg ? tradeAvg + ' / 5' : 'Not rated', ratingColor(tradeAvg)],
   ['Feedback Entries', fbCount, 'var(--ink)'],
   ['Rotations', rotCount, 'var(--ink)']].forEach(([label, val, col]) => {
    html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">';
    html += '<span style="color:var(--ink-3)">' + label + '</span><span style="font-weight:700;color:' + col + '">' + val + '</span>';
    html += '</div>';
  });
  html += '</div>';
  html += '</div>';

  // Action buttons
  if (isManager) {
    html += '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">';
    html += '<button class="btn btn-primary btn-sm" onclick="openFeedbackForm(' + profile.id + ',\'' + esc(personName) + '\')">+ Give Feedback</button>';
    html += '<button class="btn btn-secondary btn-sm" onclick="openTradesmanRatingForm(' + profile.id + ',\'' + esc(personName) + '\')">Rate Skills</button>';
    html += '<button class="btn btn-secondary btn-sm" onclick="openAddRotation(' + profile.id + ',\'' + esc(personName) + '\')">+ Add Rotation</button>';
    html += '</div>';
  } else if (typeof staffTsPerson !== 'undefined' && staffTsPerson
      && String(staffTsPerson.id) === String(profile.person_id)) {
    // Self-view: apprentice-initiated actions only (no assessing themselves)
    html += '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">';
    html += '<button class="btn btn-primary btn-sm" onclick="openRequestFeedbackForm(' + profile.id + ')">💬 Ask for Feedback</button>';
    html += '<button class="btn btn-secondary btn-sm" onclick="openSelfAssessmentForm(' + profile.id + ')">⭐ How am I going?</button>';
    html += '</div>';
  }
  return html;
}

// ── Pending / inbound request cards (v2.3 / 3F) ───────────────

function renderPendingRequestsCard(profile, personName) {
  const pending = getPendingFeedbackRequests(profile.id);
  if (!pending.length) return '';
  const isSelf = (typeof staffTsPerson !== 'undefined' && staffTsPerson
    && String(staffTsPerson.id) === String(profile.person_id));
  let html = '<div class="roster-card" style="padding:14px 18px;grid-column:1/-1;background:#F5F3FF;border-left:4px solid var(--purple)">';
  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">';
  html += '<div style="font-size:18px">💬</div>';
  html += '<div style="font-size:12px;font-weight:700;color:var(--navy)">' + (isSelf ? 'You\'ve asked for feedback' : 'Open asks from ' + esc(personName)) + '</div>';
  html += '</div>';
  pending.forEach(r => {
    const when = new Date(r.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    html += '<div style="background:#fff;border-radius:6px;padding:10px 12px;margin-top:6px;font-size:12px;color:var(--ink-2)">';
    html += '<div style="font-size:11px;color:var(--ink-3);margin-bottom:3px">Asked ' + esc(r.requested_of || 'someone') + ' · ' + when + '</div>';
    if (r.prompt) html += '<div style="line-height:1.5">' + esc(r.prompt) + '</div>';
    else html += '<div style="color:var(--ink-3);font-style:italic">No specific question — general check-in</div>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

// ── Follow-ups card (v2.1) ────────────────────────────────────
// "Things to help them with" — unresolved follow_up items on the
// apprentice's feedback history. One-tap resolve. Soft amber nudge
// only on items older than 30 days. Card hides itself when empty.

function renderFollowUpsCard(profile, personName) {
  const open = feedbackEntries
    .filter(f => f.apprentice_id === profile.id && f.follow_up && !f.resolved_at)
    .sort((a, b) => (a.feedback_date || '').localeCompare(b.feedback_date || ''));

  if (!open.length) return '';

  let html = '<div class="roster-card" style="padding:18px 20px;grid-column:1/-1">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
  html += '<div>';
  html += '<div style="font-size:13px;font-weight:700;color:var(--navy)">🌱 Things to help ' + esc((personName || '').split(' ')[0] || 'them') + ' with</div>';
  html += '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">Open follow-ups from recent feedback — tick them off as you chat.</div>';
  html += '</div>';
  html += '<div style="font-size:11px;color:var(--ink-3);font-weight:600">' + open.length + ' open</div>';
  html += '</div>';

  open.forEach(f => {
    const ageDays = _daysSince(f.feedback_date);
    const stale = ageDays >= 30;
    const dateStr = new Date(f.feedback_date + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    const cardBg = stale ? '#FFFBEB' : 'var(--surface-2)';
    const cardBorder = stale ? '1px solid #FDE68A' : '1px solid var(--border)';

    html += '<div style="background:' + cardBg + ';border:' + cardBorder + ';border-radius:8px;padding:10px 12px;margin-bottom:8px">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">';
    html += '<div style="flex:1;min-width:0">';
    html += '<div style="font-size:12px;color:var(--ink);line-height:1.5">' + esc(f.follow_up) + '</div>';
    html += '<div style="font-size:10px;color:var(--ink-3);margin-top:4px">From ' + esc(f.submitted_by || 'feedback') + ' · ' + dateStr;
    if (stale) html += ' <span style="color:#D97706;font-weight:600">· ' + ageDays + ' days open</span>';
    html += '</div></div>';
    if (isManager) {
      html += '<button onclick="resolveFollowUp(' + f.id + ',' + profile.id + ')" class="btn btn-primary btn-sm" style="white-space:nowrap">Done — had the chat</button>';
    }
    html += '</div></div>';
  });

  html += '</div>';
  return html;
}

async function resolveFollowUp(feedbackId, profileId) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const note = prompt('How did it go? (optional — leave blank to just mark done)', '') || null;
  try {
    await sbFetch('feedback_entries?id=eq.' + feedbackId, 'PATCH', {
      resolved_at: new Date().toISOString(),
      resolution_note: note && note.trim() ? note.trim() : null,
      resolved_by: currentManagerName || null,
    });
    // Update in-memory
    const idx = feedbackEntries.findIndex(f => String(f.id) === String(feedbackId));
    if (idx >= 0) {
      feedbackEntries[idx].resolved_at = new Date().toISOString();
      feedbackEntries[idx].resolution_note = note && note.trim() ? note.trim() : null;
      feedbackEntries[idx].resolved_by = currentManagerName || null;
    }
    showToast('Nice — marked sorted ✓');
    renderApprenticeProfile(profileId);
  } catch (e) {
    showToast('Couldn\'t save — check connection');
  }
}

// ── Skills Passport tab ───────────────────────────────────────

function renderSkillsPassportTab(profile) {
  const periods = [...new Set(skillsRatings.filter(r => r.apprentice_id === profile.id).map(r => r.period))]
    .sort((a, b) => _periodRank(a) - _periodRank(b));
  // Prefer the current quarter if it has any data — users rating "now"
  // expect to see "now", not whatever future-dated row someone keyed in.
  // Fall back to the highest-ranked period if the current quarter is empty.
  const currentPeriod = getCurrentPeriod();
  const latestPeriod = periods.includes(currentPeriod)
    ? currentPeriod
    : (periods[periods.length - 1] || null);

  let html = '<div style="margin-top:16px">';
  if (periods.length > 1) {
    html += '<div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">';
    periods.forEach(p => {
      html += '<button onclick="renderPassportForPeriod(' + profile.id + ',\'' + esc(p) + '\')" class="btn btn-' + (p === latestPeriod ? '' : 'secondary ') + 'btn-sm">' + esc(p) + '</button>';
    });
    html += '</div>';
  }
  if (!latestPeriod) {
    html += '<div class="empty"><div class="empty-icon">🎯</div><p>No ratings yet. Tap \'How am I going?\' to start — takes 2 minutes.</p>';
    html += '<button class="btn btn-primary" style="margin-top:12px" onclick="openSelfAssessmentForm(' + profile.id + ')">How am I going? 🤔</button></div>';
    html += '</div>';
    return html;
  }
  html += renderPassportGrid(profile, latestPeriod);

  // Growth view (v2.1) — only shows if there are at least 2 periods of self ratings
  html += renderGrowthView(profile, periods);

  html += '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">';
  html += '<button class="btn btn-primary btn-sm" onclick="openSelfAssessmentForm(' + profile.id + ')">How am I going? 🤔</button>';
  if (isManager) {
    html += '<button class="btn btn-secondary btn-sm" onclick="openTradesmanRatingForm(' + profile.id + ',\'\')">How are they actually going? 😎</button>';
    html += '<button class="btn btn-secondary btn-sm" onclick="addCustomCompetency(' + profile.id + ')">+ Custom skill</button>';
  }
  html += '</div>';
  html += '</div>';
  return html;
}

// Accepts a profile object (preferred) or a raw apprentice id. The
// profile form is required to render per-apprentice custom comps;
// legacy callers passing an id will fall back to looking the profile
// up from state.
function renderPassportGrid(profileOrId, period) {
  let profile, apprenticeId;
  if (profileOrId && typeof profileOrId === 'object') {
    profile = profileOrId;
    apprenticeId = profile.id;
  } else {
    apprenticeId = profileOrId;
    profile = apprenticeProfiles.find(p => String(p.id) === String(apprenticeId)) || null;
  }
  const appRatings = skillsRatings.filter(r => r.apprentice_id === apprenticeId && r.period === period);
  const selfMap = {};
  const tradeMap = {};
  appRatings.forEach(r => {
    if (r.rating_type === 'self') selfMap[r.competency_id] = r;
    else tradeMap[r.competency_id] = r;
  });

  let html = '<div class="roster-card" style="overflow-x:auto">';
  html += '<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">';
  html += '<span style="font-size:13px;font-weight:700;color:var(--navy)">Skills Passport — ' + esc(period) + '</span>';
  html += '<div style="display:flex;gap:10px;font-size:11px">';
  html += '<span><span style="color:#DC2626;font-weight:700">● </span>Needs attention (1–2)</span>';
  html += '<span><span style="color:#D97706;font-weight:700">● </span>Progressing (3)</span>';
  html += '<span><span style="color:#16A34A;font-weight:700">● </span>Confident (4–5)</span>';
  html += '</div></div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
  html += '<thead><tr style="background:var(--navy);color:white">';
  html += '<th style="padding:10px 14px;text-align:left;width:45%">Competency</th>';
  html += '<th style="padding:10px 10px;text-align:center">Self</th>';
  html += '<th style="padding:10px 10px;text-align:center">Tradesman</th>';
  html += '<th style="padding:10px 10px;text-align:center">Gap</th>';
  html += '</tr></thead><tbody>';

  const effective = profile ? getEffectiveCompetencies(profile) : competencies;
  effective.forEach((comp, i) => {
    let selfR, tradeR;
    if (comp._custom) {
      selfR = profile ? getCustomRating(profile, comp.id, 'self', period) : null;
      tradeR = profile ? getCustomRating(profile, comp.id, 'tradesman', period) : null;
    } else {
      const self = selfMap[comp.id];
      const trade = tradeMap[comp.id];
      selfR = self ? self.rating : null;
      tradeR = trade ? trade.rating : null;
    }
    const gap = (selfR !== null && tradeR !== null) ? Math.abs(selfR - tradeR) : null;
    const hasGapWarning = gap !== null && gap >= 2;
    const rowBg = hasGapWarning ? 'background:#FFFBEB;border-left:3px solid #D97706' : (i % 2 === 0 ? '' : 'background:var(--surface-2)');

    html += '<tr style="border-bottom:1px solid var(--border);' + rowBg + '">';
    html += '<td style="padding:9px 14px;font-weight:500;color:var(--ink);display:flex;align-items:center;gap:6px">';
    if (comp._custom) {
      html += '<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:#EEF2FF;color:#4338CA">✨ custom</span> ';
    }
    html += esc(comp.name);
    if (comp._custom && isManager && profile) {
      html += ' <button onclick="removeCustomCompetency(' + profile.id + ',\'' + esc(comp.id) + '\')" title="Remove this skill" style="margin-left:auto;background:none;border:none;color:var(--ink-4);font-size:14px;cursor:pointer;padding:0 4px">✕</button>';
    }
    html += '</td>';
    html += '<td style="padding:9px 10px;text-align:center">' + (selfR ? '<span style="font-size:15px;font-weight:800;color:' + ratingColor(selfR) + ';background:' + ratingBg(selfR) + ';padding:2px 8px;border-radius:6px">' + selfR + '</span>' : '<span style="color:var(--ink-4);font-size:11px">—</span>') + '</td>';
    html += '<td style="padding:9px 10px;text-align:center">' + (tradeR ? '<span style="font-size:15px;font-weight:800;color:' + ratingColor(tradeR) + ';background:' + ratingBg(tradeR) + ';padding:2px 8px;border-radius:6px">' + tradeR + '</span>' : '<span style="color:var(--ink-4);font-size:11px">—</span>') + '</td>';
    html += '<td style="padding:9px 10px;text-align:center">';
    if (gap !== null) {
      const gc = gap >= 2 ? '#D97706' : gap >= 1 ? '#6B7280' : '#16A34A';
      html += '<span style="font-size:12px;font-weight:700;color:' + gc + '">' + (gap === 0 ? '✓' : gap) + '</span>';
    } else {
      html += '<span style="color:var(--ink-4);font-size:11px">—</span>';
    }
    html += '</td></tr>';
  });

  html += '</tbody></table>';
  html += '<div style="padding:10px 14px;font-size:11px;color:var(--ink-3);background:var(--surface-2);border-top:1px solid var(--border)">1 = Not confident · 2 = Need supervision · 3 = Some help · 4 = Confident · 5 = Could teach others</div>';
  html += '</div>';
  return html;
}

// ── Growth view (v2.1) ────────────────────────────────────────
// Positive-framed QoQ sparkline. Uses SELF ratings (apprentice's own
// view of their progress). Shows last 4 periods, one row per
// competency, coloured dots + delta chip. Flat/dipping periods get
// soft amber framing (not red) — this is about forward momentum,
// not compliance.

function renderGrowthView(profileOrId, allPeriods) {
  if (!allPeriods || allPeriods.length < 2) return '';
  let profile, apprenticeId;
  if (profileOrId && typeof profileOrId === 'object') {
    profile = profileOrId;
    apprenticeId = profile.id;
  } else {
    apprenticeId = profileOrId;
    profile = apprenticeProfiles.find(p => String(p.id) === String(apprenticeId)) || null;
  }

  const window4 = allPeriods.slice(-4); // last up to 4 periods
  const selfForApp = skillsRatings.filter(r =>
    r.apprentice_id === apprenticeId && r.rating_type === 'self'
  );
  const effective = profile ? getEffectiveCompetencies(profile) : competencies;
  // Only include competencies that have at least 2 data points in the window
  const trendRows = [];
  effective.forEach(comp => {
    const points = window4.map(p => {
      if (comp._custom) {
        return profile ? getCustomRating(profile, comp.id, 'self', p) : null;
      }
      const hit = selfForApp.find(r => r.competency_id === comp.id && r.period === p);
      return hit ? hit.rating : null;
    });
    const dataPoints = points.filter(v => v !== null);
    if (dataPoints.length < 2) return;
    const first = dataPoints[0];
    const last = dataPoints[dataPoints.length - 1];
    const delta = last - first;
    trendRows.push({ comp, points, first, last, delta });
  });

  if (!trendRows.length) return '';

  const grewCount = trendRows.filter(r => r.delta > 0).length;

  let html = '<div class="roster-card" style="padding:16px 20px;margin-top:14px">';
  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">';
  html += '<div style="font-size:13px;font-weight:700;color:var(--navy)">📈 How you\'ve grown</div>';
  html += '<div style="font-size:11px;color:var(--ink-3)">Last ' + window4.length + ' quarters · self ratings</div>';
  html += '</div>';

  if (grewCount > 0) {
    html += '<div style="font-size:12px;color:var(--ink-2);margin-bottom:12px">You\'ve gained ground in <strong style="color:#16A34A">' + grewCount + ' area' + (grewCount === 1 ? '' : 's') + '</strong> across this window — nice work.</div>';
  } else {
    html += '<div style="font-size:12px;color:var(--ink-2);margin-bottom:12px">Steady through this window. A new rating will show fresh movement.</div>';
  }

  // Row per competency: label | dots | delta chip
  trendRows.forEach(({ comp, points, delta }) => {
    html += '<div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">';
    html += '<div style="flex:1;min-width:0;color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(comp.name) + '</div>';
    html += '<div>' + _renderDotStrip(points) + '</div>';
    html += '<div style="min-width:52px;text-align:right">' + _renderDeltaChip(delta) + '</div>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function _renderDotStrip(points) {
  // points is array of (1-5 rating | null). Render as SVG horizontal dots.
  const w = 96;
  const h = 22;
  const n = points.length;
  const gap = n > 1 ? w / (n - 1) : 0;
  let svg = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="display:block">';
  // Connector line (low-contrast)
  for (let i = 0; i < n - 1; i++) {
    if (points[i] !== null && points[i + 1] !== null) {
      const x1 = i * gap;
      const x2 = (i + 1) * gap;
      const y1 = _scoreToY(points[i], h);
      const y2 = _scoreToY(points[i + 1], h);
      svg += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="#CBD5E1" stroke-width="1.5"/>';
    }
  }
  // Dots
  points.forEach((p, i) => {
    const x = i * gap;
    const y = p !== null ? _scoreToY(p, h) : (h / 2);
    const col = p !== null ? ratingColor(p) : '#E5E7EB';
    const r = p !== null ? 4 : 3;
    svg += '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + col + '"/>';
  });
  svg += '</svg>';
  return svg;
}

function _scoreToY(score, h) {
  // 1 → bottom, 5 → top, with small inset
  const inset = 3;
  const usable = h - inset * 2;
  const t = (score - 1) / 4; // 0..1
  return (h - inset) - t * usable;
}

function _renderDeltaChip(delta) {
  if (delta > 0) {
    return '<span style="display:inline-block;font-size:11px;font-weight:700;color:#16A34A;background:#F0FDF4;padding:2px 8px;border-radius:10px">▲ +' + delta.toFixed(0) + '</span>';
  }
  if (delta < 0) {
    return '<span style="display:inline-block;font-size:11px;font-weight:700;color:#D97706;background:#FFFBEB;padding:2px 8px;border-radius:10px">▼ ' + delta.toFixed(0) + '</span>';
  }
  return '<span style="display:inline-block;font-size:11px;font-weight:700;color:#64748B;background:#F1F5F9;padding:2px 8px;border-radius:10px">— steady</span>';
}

function renderPassportForPeriod(apprenticeId, period) {
  const container = document.getElementById('apprentices-content');
  if (!container) return;
  // Re-render passport tab with selected period
  const profile = apprenticeProfiles.find(p => String(p.id) === String(apprenticeId));
  if (!profile) return;
  // Find the passport-grid div and replace just that
  const gridEl = container.querySelector('.passport-grid-wrap');
  if (gridEl) {
    gridEl.innerHTML = renderPassportGrid(profile, period);
  } else {
    renderApprenticeProfile(apprenticeId);
  }
}

// ── Feedback tab ──────────────────────────────────────────────

function renderFeedbackTab(profile, personName) {
  const entries = feedbackEntries.filter(f => f.apprentice_id === profile.id);
  let html = '<div style="margin-top:16px">';
  if (isManager) {
    html += '<div style="display:flex;justify-content:flex-end;margin-bottom:12px">';
    html += '<button class="btn btn-primary btn-sm" onclick="openFeedbackForm(' + profile.id + ',\'' + esc(personName) + '\')">+ Give Feedback</button>';
    html += '</div>';
  }
  if (!entries.length) {
    html += '<div class="empty"><div class="empty-icon">💬</div><p>No feedback entries yet.</p></div>';
    html += '</div>';
    return html;
  }
  entries.forEach(entry => {
    const comp = competencies.find(c => String(c.id) === String(entry.competency_id));
    const dateStr = new Date(entry.feedback_date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    html += '<div class="roster-card" style="padding:16px 18px;margin-bottom:10px">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">';
    html += '<div><div style="font-size:13px;font-weight:700;color:var(--navy)">' + esc(entry.submitted_by) + '</div>';
    html += '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">' + dateStr + (entry.project_site ? ' · ' + esc(entry.project_site) : '') + '</div></div>';
    if (entry.rating) html += '<span style="font-size:18px;font-weight:800;color:' + ratingColor(entry.rating) + ';background:' + ratingBg(entry.rating) + ';padding:3px 10px;border-radius:8px">' + entry.rating + '/5</span>';
    html += '</div>';
    if (comp) html += '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--purple);background:var(--purple-lt);padding:2px 8px;border-radius:4px;display:inline-block;margin-bottom:10px">' + esc(comp.name) + '</div>';
    [['✅ What they did well', entry.did_well], ['⏭ Trust them next with', entry.trust_next], ['🔧 Needs to improve', entry.needs_improve], ['📌 Follow-up', entry.follow_up]].forEach(([label, val]) => {
      if (!val) return;
      html += '<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">' + label + '</div>';
      html += '<div style="font-size:12px;color:var(--ink-2);line-height:1.5;padding-left:8px;border-left:3px solid var(--border)">' + esc(val) + '</div></div>';
    });
    // v2.1 — show resolution state on follow-ups inline in feedback feed
    if (entry.follow_up && entry.resolved_at) {
      const resolvedStr = new Date(entry.resolved_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      html += '<div style="margin-top:6px;padding:8px 10px;background:#F0FDF4;border-left:3px solid #16A34A;border-radius:4px;font-size:11px;color:#166534">';
      html += '✓ Sorted ' + resolvedStr;
      if (entry.resolved_by) html += ' by ' + esc(entry.resolved_by);
      if (entry.resolution_note) html += ' — <em>' + esc(entry.resolution_note) + '</em>';
      html += '</div>';
    }
    html += '</div>';
  });
  html += '</div>';
  return html;
}

// ── Rotations tab ─────────────────────────────────────────────

function renderRotationsTab(profile) {
  const rots = apprenticeRotations.filter(r => r.apprentice_id === profile.id);
  const personName = getPersonNameById(profile.person_id);
  let html = '<div style="margin-top:16px">';
  if (isManager) {
    html += '<div style="display:flex;justify-content:flex-end;margin-bottom:12px">';
    html += '<button class="btn btn-primary btn-sm" onclick="openAddRotation(' + profile.id + ',\'' + esc(personName) + '\')">+ Add Rotation</button>';
    html += '</div>';
  }
  if (!rots.length) {
    html += '<div class="empty"><div class="empty-icon">🏗</div><p>No rotations recorded yet</p></div></div>';
    return html;
  }
  rots.forEach(rot => {
    const start = new Date(rot.date_start + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    const end = rot.date_end ? new Date(rot.date_end + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Ongoing';
    html += '<div class="roster-card" style="padding:12px 14px;margin-bottom:8px">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start">';
    html += '<div><div style="font-size:13px;font-weight:700;color:var(--navy)">' + esc(rot.project_site) + '</div>';
    html += '<div style="font-size:11px;color:var(--ink-3);margin-top:2px">' + start + ' → ' + end + (rot.supervisor ? ' · ' + esc(rot.supervisor) : '') + '</div></div>';
    if (!rot.date_end) html += '<span style="font-size:10px;font-weight:700;color:#16A34A;background:#F0FDF4;padding:2px 8px;border-radius:4px">Active</span>';
    html += '</div>';
    if (rot.main_work) html += '<div style="font-size:12px;color:var(--ink-2);margin-top:8px;line-height:1.5">' + esc(rot.main_work) + '</div>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

// ── Add Contact (entry point — source of truth) ───────────────

function openAddContact() {
  // Navigate to Contacts page with add form open, or show inline if that's not available
  if (typeof openAddPersonModal === 'function') {
    openAddPersonModal();
    showToast('Add the person as a contact first, then set up their apprentice profile');
  } else if (typeof navigateTo === 'function') {
    navigateTo('contacts');
    showToast('Add the apprentice as a contact, then return here to set up their profile');
  } else {
    showToast('Go to Contacts → Add Person to create the apprentice contact first');
  }
}

// ── Setup profile (contact exists, no profile yet) ────────────

function openSetupProfile(personName) {
  const modal = document.getElementById('modal-apprentice-profile');
  if (!modal) return;
  document.getElementById('ap-edit-id').value = '';
  document.getElementById('ap-year').value = '1';
  document.getElementById('ap-start-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('ap-notes').value = '';
  document.getElementById('ap-goal-tech').value = '';
  document.getElementById('ap-goal-prof').value = '';
  document.getElementById('ap-goal-personal').value = '';

  // Only this person — they already exist as a contact
  const person = (STATE.people || []).find(p => p.name === personName);
  let personHtml = '<option value="' + esc(personName) + '" selected>' + esc(personName) + '</option>';
  document.getElementById('ap-person').innerHTML = personHtml;
  document.getElementById('ap-person').disabled = true;

  let siteHtml = '<option value="">— None —</option>';
  (STATE.sites || []).forEach(s => { siteHtml += '<option value="' + esc(s.abbr) + '">' + esc(s.abbr) + ' — ' + esc(s.name) + '</option>'; });
  document.getElementById('ap-site').innerHTML = siteHtml;

  document.getElementById('modal-ap-title').textContent = 'Set Up Profile — ' + personName;
  refreshGoalSuggestions();
  openModal('modal-apprentice-profile');
}

// ── Edit Goals / Profile ──────────────────────────────────────

function openEditGoals(profileId) {
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile) return;
  if (!canEditThisProfile(profile)) { showToast('You can only edit your own goals'); return; }
  const modal = document.getElementById('modal-apprentice-profile');
  if (!modal) return;
  const personName = getPersonNameById(profile.person_id);

  document.getElementById('ap-edit-id').value = profileId;
  document.getElementById('ap-year').value = profile.year_level || 1;
  document.getElementById('ap-start-date').value = profile.start_date || '';
  document.getElementById('ap-notes').value = profile.notes || '';
  document.getElementById('ap-goal-tech').value = profile.goal_technical || '';
  document.getElementById('ap-goal-prof').value = profile.goal_professional || '';
  document.getElementById('ap-goal-personal').value = profile.goal_personal || '';

  document.getElementById('ap-person').innerHTML = '<option value="' + esc(personName) + '">' + esc(personName) + '</option>';
  document.getElementById('ap-person').disabled = true;

  let siteHtml = '<option value="">— None —</option>';
  (STATE.sites || []).forEach(s => { siteHtml += '<option value="' + esc(s.abbr) + '"' + (s.abbr === profile.current_site ? ' selected' : '') + '>' + esc(s.abbr) + ' — ' + esc(s.name) + '</option>'; });
  document.getElementById('ap-site').innerHTML = siteHtml;

  // Self-edit mode: apprentices editing their own profile can only touch
  // goal fields — year, start date, site and notes stay supervisor-managed.
  const selfEditMode = !isManager;
  ['ap-year', 'ap-start-date', 'ap-site', 'ap-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = selfEditMode;
      // Visually dim the disabled rows so it's obvious what's yours vs. theirs
      const wrap = el.closest('.form-row') || el.parentElement;
      if (wrap) wrap.style.opacity = selfEditMode ? '0.45' : '1';
    }
  });

  document.getElementById('modal-ap-title').textContent = selfEditMode
    ? 'Edit My Goals — ' + personName
    : 'Edit Profile — ' + personName;
  refreshGoalSuggestions();
  openModal('modal-apprentice-profile');
}

// ── Edit contact year level ───────────────────────────────────

function openEditContactYear(personName, profileId) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const person = (STATE.people || []).find(p => p.name === personName);
  const currentYear = (person && person.year_level) || '';
  const modal = document.getElementById('modal-apprentice-profile');
  if (!modal) { showToast('Edit contact in the Contacts page'); return; }
  openEditGoals(profileId);
}

// ── Save Profile ──────────────────────────────────────────────

async function saveApprenticeProfile() {
  const editId = document.getElementById('ap-edit-id').value;
  const personName = document.getElementById('ap-person').value;
  const yearLevel = parseInt(document.getElementById('ap-year').value);
  const startDate = document.getElementById('ap-start-date').value || null;
  const notes = document.getElementById('ap-notes').value.trim();
  const goalTech = document.getElementById('ap-goal-tech').value.trim();
  const goalProf = document.getElementById('ap-goal-prof').value.trim();
  const goalPersonal = document.getElementById('ap-goal-personal').value.trim();
  const site = document.getElementById('ap-site').value || null;

  if (!personName) { showToast('Select an apprentice'); return; }

  // Editing existing profile — gate on canEditThisProfile (manager OR self).
  // Creating a new profile — always supervisor-gated.
  let editProfile = null;
  if (editId) {
    editProfile = apprenticeProfiles.find(p => String(p.id) === String(editId));
    if (!canEditThisProfile(editProfile)) { showToast('You can only edit your own goals'); return; }
  } else if (!isManager) {
    showToast('Supervision access required'); return;
  }

  const nowIso = new Date().toISOString();
  const editorName = _editorDisplayName();
  const selfOnly = !!(editId && !isManager);

  // Self-edit: goals only + audit stamps. Everything else stays untouched
  // so the apprentice can't bump their own year level or reassign site.
  const profileRow = selfOnly
    ? {
        goal_technical: goalTech,
        goal_professional: goalProf,
        goal_personal: goalPersonal,
        goals_updated_at: nowIso,
        goals_updated_by: editorName,
        updated_at: nowIso,
      }
    : {
        year_level: yearLevel,
        start_date: startDate,
        notes,
        goal_technical: goalTech,
        goal_professional: goalProf,
        goal_personal: goalPersonal,
        current_site: site,
        goals_updated_at: nowIso,
        goals_updated_by: editorName,
        updated_at: nowIso,
      };

  try {
    if (editId) {
      await sbFetch('apprentice_profiles?id=eq.' + editId, 'PATCH', profileRow);
      // Also update year_level on people (contacts = source of truth).
      // Skipped in self-edit mode — apprentice can't change their own year.
      if (!selfOnly) {
        const personObj = (STATE.people || []).find(p => p.name === personName);
        if (personObj) {
          await sbFetch('people?id=eq.' + personObj.id, 'PATCH', { year_level: yearLevel });
          personObj.year_level = yearLevel; // update SEED in memory
        }
      }
      const idx = apprenticeProfiles.findIndex(p => String(p.id) === String(editId));
      if (idx >= 0) Object.assign(apprenticeProfiles[idx], profileRow);
      showToast(selfOnly ? 'Goals updated ✓' : 'Profile updated ✓');
      closeModal('modal-apprentice-profile');
      document.getElementById('ap-person').disabled = false;
      // Re-enable any fields we disabled for self-edit mode
      ['ap-year','ap-start-date','ap-site','ap-notes'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.disabled = false;
          const wrap = el.closest('.form-row') || el.parentElement;
          if (wrap) wrap.style.opacity = '1';
        }
      });
      renderApprenticeProfile(editId);
    } else {
      // New profile — resolve DB UUID from person name
      let resolvedPersonId = null;
      try {
        const dbPpl = await sbFetch('people?name=eq.' + encodeURIComponent(personName) + '&select=id&limit=1');
        if (dbPpl && dbPpl[0]) resolvedPersonId = dbPpl[0].id;
      } catch(e) {}
      if (!resolvedPersonId) { showToast('Could not find contact — add them in Contacts first'); return; }

      profileRow.person_id = resolvedPersonId;
      profileRow.org_id = TENANT.ORG_UUID;
      profileRow.active = true;

      // Also stamp year_level on people record
      await sbFetch('people?id=eq.' + resolvedPersonId, 'PATCH', { year_level: yearLevel });
      const personObj = (STATE.people || []).find(p => p.name === personName);
      if (personObj) personObj.year_level = yearLevel;

      const res = await sbFetch('apprentice_profiles', 'POST', profileRow, 'return=representation');
      const newProfile = res && res[0];
      if (newProfile) {
        newProfile._resolvedName = personName;
        newProfile._resolvedYear = yearLevel;
        apprenticeProfiles.push(newProfile);
        showToast('Profile created ✓');
        closeModal('modal-apprentice-profile');
        document.getElementById('ap-person').disabled = false;
        activeApprenticeId = newProfile.id;
        activeApprenticeTab = 'overview';
        renderApprenticeProfile(newProfile.id);
      }
    }
  } catch(e) {
    showToast('Save failed — ' + (e.message || 'check connection'));
  }
}

// ── Self-assessment form ──────────────────────────────────────

function openSelfAssessmentForm(profileId) {
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile) return;
  const personName = getPersonNameById(profile.person_id);
  const modal = document.getElementById('modal-apprentice-self');
  if (!modal) return;

  document.getElementById('sa-apprentice-id').value = profileId;
  document.getElementById('modal-sa-title').textContent = 'How am I going? 🤔 — ' + personName;

  // Period dropdown
  const periodWrap = document.getElementById('sa-period-wrap');
  if (periodWrap) periodWrap.innerHTML = periodSelectHtml('sa-period', getCurrentPeriod());

  // Build rating history — merge standard + custom self ratings, keyed
  // by period then by comp id (stringified for custom compatibility).
  const existing = {};
  skillsRatings.filter(r => r.apprentice_id === profileId && r.rating_type === 'self').forEach(r => {
    if (!existing[r.period]) existing[r.period] = {};
    existing[r.period][String(r.competency_id)] = r.rating;
  });
  const customRatings = getCustomRatings(profile);
  Object.keys(customRatings).forEach(compId => {
    const perPeriod = (customRatings[compId] || {}).self || {};
    Object.keys(perPeriod).forEach(p => {
      if (!existing[p]) existing[p] = {};
      existing[p][compId] = perPeriod[p];
    });
  });
  const selPeriod = getCurrentPeriod();
  const existingForPeriod = existing[selPeriod] || {};

  const effective = getEffectiveCompetencies(profile);

  let gridHtml = '';
  effective.forEach(comp => {
    const attr = _compAttr(comp.id);
    const current = existingForPeriod[String(comp.id)] || 0;
    gridHtml += '<div style="padding:14px 0;border-bottom:1px solid var(--border)">';
    gridHtml += '<div style="font-size:13px;font-weight:600;color:var(--navy);margin-bottom:8px;display:flex;align-items:center;gap:6px">';
    if (comp._custom) {
      gridHtml += '<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:#EEF2FF;color:#4338CA">✨ custom</span>';
    }
    gridHtml += esc(comp.name) + '</div>';
    gridHtml += '<div style="display:flex;gap:2px" data-comp-id="' + attr + '">';
    for (let i = 1; i <= 5; i++) {
      gridHtml += '<button class="sa-star" data-comp="' + attr + '" data-val="' + i + '" onclick="setSAStarRating(this,\'' + attr + '\',' + i + ')" style="background:none;border:none;cursor:pointer;font-size:36px;padding:4px 6px;color:' + (i <= current ? '#F59E0B' : '#E5E7EB') + ';transition:color .1s;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center">★</button>';
    }
    gridHtml += '</div>';
    const scaleLabels = ['', 'Not confident', 'Need supervision', 'Some help', 'Confident', 'Could teach'];
    gridHtml += '<div style="font-size:11px;color:var(--ink-3);margin-top:4px" id="sa-label-' + attr + '">' + (current > 0 ? scaleLabels[current] : 'Tap to rate') + '</div>';
    gridHtml += '</div>';
  });
  document.getElementById('sa-competencies-grid').innerHTML = gridHtml;

  // Update grid when period changes
  const periodEl = document.getElementById('sa-period');
  if (periodEl) {
    periodEl.onchange = function() {
      const p = this.value;
      const ex = existing[p] || {};
      effective.forEach(comp => {
        const attr = _compAttr(comp.id);
        const r = ex[String(comp.id)] || 0;
        const container = document.querySelector('[data-comp-id="' + attr + '"]');
        if (!container) return;
        container.querySelectorAll('.sa-star[data-comp="' + attr + '"]').forEach((s, i) => { s.style.color = i < r ? '#F59E0B' : '#E5E7EB'; });
        const lbl = document.getElementById('sa-label-' + attr);
        const scaleLabels = ['', 'Not confident', 'Need supervision', 'Some help', 'Confident', 'Could teach'];
        if (lbl) lbl.textContent = r > 0 ? scaleLabels[r] : 'Tap to rate';
      });
    };
  }

  openModal('modal-apprentice-self');
}

function setSAStarRating(btn, attrId, val) {
  const container = btn.closest('[data-comp-id="' + attrId + '"]');
  if (!container) return;
  container.querySelectorAll('.sa-star[data-comp="' + attrId + '"]').forEach((s, i) => {
    s.style.color = i < val ? '#F59E0B' : '#E5E7EB';
  });
  const scaleLabels = ['', 'Not confident', 'Need supervision', 'Some help', 'Confident', 'Could teach'];
  const lbl = document.getElementById('sa-label-' + attrId);
  if (lbl) lbl.textContent = scaleLabels[val] || '';
}

async function submitSelfAssessment() {
  const profileId = document.getElementById('sa-apprentice-id').value;
  const period = document.getElementById('sa-period').value;
  if (!period) { showToast('Select a period'); return; }
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile) return;
  const ratedBy = getPersonNameById(profile.person_id);

  const effective = getEffectiveCompetencies(profile);
  const ratingRows = [];              // standard comps → skills_ratings
  const customUpdates = {};           // custom comps → profile JSON
  effective.forEach(comp => {
    const attr = _compAttr(comp.id);
    const container = document.querySelector('[data-comp-id="' + attr + '"]');
    if (!container) return;
    const stars = container.querySelectorAll('.sa-star[data-comp="' + attr + '"]');
    let rating = 0;
    stars.forEach((s, i) => { if (s.style.color === 'rgb(245, 158, 11)') rating = i + 1; });
    if (rating <= 0) return;
    if (comp._custom) {
      customUpdates[comp.id] = rating;
    } else {
      ratingRows.push({ competency_id: comp.id, rating, period, rating_type: 'self', rated_by: ratedBy, apprentice_id: profileId, org_id: TENANT.ORG_UUID });
    }
  });

  if (!ratingRows.length && !Object.keys(customUpdates).length) {
    showToast('Rate at least one competency'); return;
  }

  try {
    if (ratingRows.length) {
      // UPSERT — ON CONFLICT update rating. Send as batch.
      // sbFetch routes through TENANT_DISABLED_TABLES (skills_ratings is
      // disabled on SKS, so the call is a no-op there instead of a 404)
      // and through the offline IDB write queue.
      await sbFetch('skills_ratings', 'POST', ratingRows, 'resolution=merge-duplicates,return=minimal');
    }

    if (Object.keys(customUpdates).length) {
      const merged = Object.assign({}, getCustomRatings(profile));
      Object.keys(customUpdates).forEach(compId => {
        if (!merged[compId]) merged[compId] = {};
        if (!merged[compId].self) merged[compId].self = {};
        merged[compId].self[period] = customUpdates[compId];
      });
      await sbFetch('apprentice_profiles?id=eq.' + profileId, 'PATCH', {
        custom_ratings: merged,
        updated_at: new Date().toISOString(),
      });
      profile.custom_ratings = merged;
    }

    showToast('Skills saved ✓');
    closeModal('modal-apprentice-self');
    await loadApprenticeData();
    renderApprenticeProfile(profileId);
  } catch(e) {
    showToast('Save failed — ' + (e.message || 'check connection'));
  }
}

// ── Feedback form ─────────────────────────────────────────────

function openFeedbackForm(profileId, personName, requestId) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const modal = document.getElementById('modal-apprentice-feedback');
  if (!modal) return;

  document.getElementById('fb-apprentice-id').value = profileId;
  document.getElementById('fb-did-well').value = '';
  document.getElementById('fb-trust-next').value = '';
  document.getElementById('fb-needs-improve').value = '';
  document.getElementById('fb-follow-up').value = '';
  document.getElementById('fb-rating').value = '';
  // Stash request id on the hidden field so submitFeedback can mark it complete
  const reqEl = document.getElementById('fb-request-id');
  if (reqEl) reqEl.value = requestId || '';
  document.getElementById('modal-fb-title').textContent = 'Give Feedback — ' + personName;

  // If this is a fulfilment of a request, surface the prompt + "asked by"
  const bannerEl = document.getElementById('fb-request-banner');
  if (bannerEl) {
    if (requestId) {
      const req = feedbackRequests.find(r => String(r.id) === String(requestId));
      if (req) {
        let banner = '<div style="background:#EEF2FF;border-left:4px solid var(--purple);padding:10px 12px;border-radius:4px;margin-bottom:12px">';
        banner += '<div style="font-size:11px;font-weight:700;color:var(--purple);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Requested by ' + esc(req.requested_by || 'apprentice') + '</div>';
        if (req.prompt) {
          banner += '<div style="font-size:12px;color:var(--ink-2);line-height:1.5">💬 ' + esc(req.prompt) + '</div>';
        } else {
          banner += '<div style="font-size:12px;color:var(--ink-3);font-style:italic">No specific prompt — give them your general thoughts.</div>';
        }
        banner += '</div>';
        bannerEl.innerHTML = banner;
        bannerEl.style.display = '';
      } else {
        bannerEl.innerHTML = '';
        bannerEl.style.display = 'none';
      }
    } else {
      bannerEl.innerHTML = '';
      bannerEl.style.display = 'none';
    }
  }

  // Name combobox
  const nameWrap = document.getElementById('fb-name-wrap');
  if (nameWrap) nameWrap.innerHTML = nameComboHtml('fb-submitted-by', 'Your name', currentManagerName || '');

  // Site / job number combobox
  const siteWrap = document.getElementById('fb-site-wrap');
  if (siteWrap) siteWrap.innerHTML = jobComboHtml('fb-site', 'Job number or site', '');

  // Competency dropdown
  let compHtml = '<option value="">— Optional: select a competency —</option>';
  competencies.forEach(c => { compHtml += '<option value="' + c.id + '">' + esc(c.name) + '</option>'; });
  document.getElementById('fb-competency').innerHTML = compHtml;

  // Suggestion dropdowns (static, not year-dependent)
  wireFeedbackSuggestions();

  openModal('modal-apprentice-feedback');
}

async function submitFeedback() {
  const profileId = document.getElementById('fb-apprentice-id').value;
  const reqEl = document.getElementById('fb-request-id');
  const requestId = reqEl ? (reqEl.value || '') : '';
  const submittedBy = document.getElementById('fb-submitted-by').value.trim();
  const didWell = document.getElementById('fb-did-well').value.trim();
  const trustNext = document.getElementById('fb-trust-next').value.trim();
  const needsImprove = document.getElementById('fb-needs-improve').value.trim();
  const followUp = document.getElementById('fb-follow-up').value.trim();
  const site = document.getElementById('fb-site').value.trim();
  const competencyId = document.getElementById('fb-competency').value || null;
  const ratingVal = document.getElementById('fb-rating').value;

  if (!submittedBy) { showToast('Enter your name'); return; }
  if (!didWell && !trustNext && !needsImprove) { showToast('Fill in at least one feedback section'); return; }

  const row = {
    apprentice_id: profileId,
    org_id: TENANT.ORG_UUID,
    submitted_by: submittedBy,
    did_well: didWell || null,
    trust_next: trustNext || null,
    needs_improve: needsImprove || null,
    follow_up: followUp || null,
    project_site: site || null,
    competency_id: competencyId ? parseInt(competencyId) : null,
    rating: ratingVal ? parseInt(ratingVal) : null,
    feedback_date: new Date().toISOString().slice(0, 10),
  };

  try {
    const created = await sbFetch('feedback_entries', 'POST', row, 'return=representation');
    const newEntry = Array.isArray(created) ? created[0] : created;
    // If this was a fulfilment of an ask, stamp the feedback_requests row.
    if (requestId && newEntry && newEntry.id) {
      try {
        await sbFetch('feedback_requests?id=eq.' + requestId, 'PATCH', {
          completed_at: new Date().toISOString(),
          feedback_entry_id: newEntry.id,
        });
      } catch(e) { /* non-fatal — feedback itself is saved */ }
    }
    showToast(requestId ? 'Feedback delivered ✓' : 'Feedback saved ✓');
    closeModal('modal-apprentice-feedback');
    // Clear deep-link state so a reopen doesn't re-bind the old request
    _pendingFeedbackRequestId = null;
    await loadApprenticeData();
    renderApprenticeProfile(profileId);
  } catch(e) {
    showToast('Save failed — check connection');
  }
}

// ── Request feedback (Tier 2 / 3F) ────────────────────────────
// Apprentice initiates: picks a supervisor, adds an optional prompt,
// sends an email, records a row in feedback_requests. Supervisor
// opens the deep link in the email, which binds the incoming
// openFeedbackForm() call to the request so it gets stamped
// completed when they submit.

function getPendingFeedbackRequests(profileId) {
  return (feedbackRequests || []).filter(r =>
    r.apprentice_id === profileId && !r.completed_at && !r.declined_at);
}

function getInboundRequestsForSupervisor(name) {
  if (!name) return [];
  const norm = String(name).trim().toLowerCase();
  return (feedbackRequests || []).filter(r =>
    !r.completed_at && !r.declined_at &&
    r.requested_of && String(r.requested_of).trim().toLowerCase() === norm);
}

function openRequestFeedbackForm(profileId) {
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile) return;
  // Self-only: only the apprentice themselves may ask for feedback on their
  // own profile. Supervisors write feedback directly, they don't need to ask.
  if (!(typeof staffTsPerson !== 'undefined' && staffTsPerson
      && String(staffTsPerson.id) === String(profile.person_id))) {
    showToast('Only you can request feedback on yourself'); return;
  }
  const modal = document.getElementById('modal-request-feedback');
  if (!modal) { showToast('Modal missing — refresh the app'); return; }
  document.getElementById('rfb-apprentice-id').value = profileId;
  document.getElementById('rfb-prompt').value = '';

  // Build supervisor options from STATE.managers. Store email as data-email.
  const sel = document.getElementById('rfb-supervisor');
  let opts = '<option value="">— Pick a supervisor —</option>';
  (STATE.managers || []).forEach(m => {
    opts += '<option value="' + esc(m.name) + '" data-email="' + esc(m.email || '') + '">' + esc(m.name) + ((m.role) ? ' — ' + esc(m.role) : '') + '</option>';
  });
  sel.innerHTML = opts;

  // Pre-populate prompt suggestions
  const sugSel = document.getElementById('rfb-prompt-suggest');
  if (sugSel) {
    const suggestions = [
      '',
      'What should I focus on this quarter?',
      'How am I tracking compared to where I should be?',
      'What\'s one thing I could do better?',
      'What are you seeing me do well lately?',
      'What skill should I push next?',
    ];
    let sHtml = '';
    suggestions.forEach((s, i) => {
      sHtml += '<option value="' + esc(s) + '">' + (i === 0 ? '— Suggestions —' : esc(s)) + '</option>';
    });
    sugSel.innerHTML = sHtml;
    sugSel.onchange = function() {
      const v = this.value;
      if (v) document.getElementById('rfb-prompt').value = v;
      this.selectedIndex = 0;
    };
  }

  openModal('modal-request-feedback');
}

async function submitFeedbackRequest() {
  const profileId = document.getElementById('rfb-apprentice-id').value;
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile) return;
  const sel = document.getElementById('rfb-supervisor');
  const supName = sel.value.trim();
  const supEmail = (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].getAttribute('data-email')) || '';
  const prompt = document.getElementById('rfb-prompt').value.trim();
  if (!supName) { showToast('Pick a supervisor'); return; }

  const apprenticeName = (staffTsPerson && staffTsPerson.name) || getPersonNameById(profile.person_id) || 'An apprentice';

  const row = {
    org_id: TENANT.ORG_UUID,
    apprentice_id: profileId,
    requested_by: apprenticeName,
    requested_of: supName,
    requested_of_email: supEmail || null,
    prompt: prompt || null,
  };

  try {
    const created = await sbFetch('feedback_requests', 'POST', row, 'return=representation');
    const newReq = Array.isArray(created) ? created[0] : created;
    feedbackRequests.unshift(newReq);

    // Fire the email — best effort. If it fails, the row still exists
    // and the supervisor sees it next time they open the app.
    if (supEmail && newReq && newReq.id) {
      const deepLink = window.location.origin + window.location.pathname + '?request=' + encodeURIComponent(newReq.id);
      const subject = apprenticeName + ' has asked for your feedback';
      const html = _renderFeedbackRequestEmail(apprenticeName, supName, prompt, deepLink);
      try {
        const eqToken = sessionStorage.getItem('eq_session_token') || localStorage.getItem('eq_agent_token') || '';
        const resp = await fetch('/.netlify/functions/send-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-eq-token': eqToken },
          body: JSON.stringify({ to: [supEmail], subject, html })
        });
        if (!resp.ok) {
          const data = await resp.json().catch(() => ({}));
          console.error('Feedback request email error:', data);
          // Don't toast error — request is still saved and surfaced in-app
        }
      } catch (e) {
        console.error('Feedback request email error:', e);
      }
    }

    showToast(supEmail ? 'Sent ✓ — email on its way' : 'Request sent ✓');
    closeModal('modal-request-feedback');
    renderApprenticeProfile(profileId);
  } catch(e) {
    showToast('Could not send — ' + (e.message || 'check connection'));
  }
}

function _renderFeedbackRequestEmail(fromName, toName, prompt, link) {
  const safeFrom = esc(fromName);
  const safeTo = esc(toName);
  const safePrompt = prompt ? esc(prompt) : '';
  let html = '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:560px;color:#1F2937;line-height:1.5">';
  html += '<div style="background:linear-gradient(135deg,#1F335C 0%,#6B5BD6 100%);color:#fff;padding:24px 28px;border-radius:8px 8px 0 0">';
  html += '<div style="font-size:13px;font-weight:700;letter-spacing:.5px;opacity:.85;text-transform:uppercase">EQ Field · Apprentice Module</div>';
  html += '<div style="font-size:22px;font-weight:700;margin-top:4px">Feedback requested</div>';
  html += '</div>';
  html += '<div style="background:#fff;padding:24px 28px;border:1px solid #E5E7EB;border-top:0;border-radius:0 0 8px 8px">';
  html += '<p style="margin:0 0 14px">Hi ' + safeTo + ',</p>';
  html += '<p style="margin:0 0 14px"><strong>' + safeFrom + '</strong> has asked for your feedback on how they\'re going.</p>';
  if (safePrompt) {
    html += '<div style="background:#EEF2FF;border-left:4px solid #6B5BD6;padding:12px 14px;border-radius:4px;margin:14px 0">';
    html += '<div style="font-size:11px;font-weight:700;color:#6B5BD6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">They\'d especially like to know</div>';
    html += '<div style="font-size:14px;color:#1F2937">' + safePrompt + '</div>';
    html += '</div>';
  }
  html += '<p style="margin:0 0 14px">Whenever you\'ve got 2 minutes, tap below to leave them a note. Short and specific is perfect — no form-filling required.</p>';
  html += '<div style="text-align:center;margin:22px 0"><a href="' + link + '" style="display:inline-block;background:#6B5BD6;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:700;font-size:14px">Give feedback →</a></div>';
  html += '<p style="margin:14px 0 0;font-size:12px;color:#64748B">You can also open the EQ Field app and find their ask in your follow-ups. No rush — they\'ll appreciate it whenever you get to it.</p>';
  html += '</div>';
  html += '</div>';
  return html;
}

// Called by app.js on load (or by our own check-on-init below) to
// handle the ?request=<uuid> deep link. Waits for apprentice data
// to be loaded so the request lookup works.
async function handleFeedbackRequestDeepLink() {
  try {
    const params = new URLSearchParams(window.location.search);
    const reqId = params.get('request');
    if (!reqId) return;
    // Only supervisors can fulfil. If the current user is not in manager
    // mode, stash the id for after they unlock.
    _pendingFeedbackRequestId = reqId;
    if (!isManager) {
      showToast('Unlock supervision to respond to this request');
      return;
    }
    const req = (feedbackRequests || []).find(r => String(r.id) === String(reqId));
    if (!req) { showToast('That feedback request is no longer available'); return; }
    if (req.completed_at) { showToast('Already completed — thanks 👍'); return; }
    const profile = apprenticeProfiles.find(p => String(p.id) === String(req.apprentice_id));
    if (!profile) return;
    const personName = getPersonNameById(profile.person_id);
    activeApprenticeId = profile.id;
    activeApprenticeTab = 'overview';
    renderApprentices();
    setTimeout(() => openFeedbackForm(profile.id, personName, reqId), 150);
  } catch(e) { console.warn('deep link handler:', e); }
}

// ── Tradesman rating form ─────────────────────────────────────

function openTradesmanRatingForm(profileId, personName) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const modal = document.getElementById('modal-apprentice-trade-rating');
  if (!modal) return;
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile) return;

  document.getElementById('tr-apprentice-id').value = profileId;
  document.getElementById('modal-tr-title').textContent = 'How are they actually going? 😎 — ' + (personName || getPersonNameById(profile.person_id));

  // Rater name combobox
  const raterWrap = document.getElementById('tr-rater-wrap');
  if (raterWrap) raterWrap.innerHTML = nameComboHtml('tr-rated-by', 'Your name', currentManagerName || '');

  // Period dropdown — matches self-assessment periods
  const periodWrap = document.getElementById('tr-period-wrap');
  if (periodWrap) periodWrap.innerHTML = periodSelectHtml('tr-period', getCurrentPeriod());

  const effective = getEffectiveCompetencies(profile);

  // Build grid with existing tradesman ratings for selected period
  const buildGrid = (period) => {
    const existing = {};
    skillsRatings.filter(r => r.apprentice_id === profileId && r.rating_type === 'tradesman' && r.period === period).forEach(r => {
      existing[String(r.competency_id)] = r.rating;
    });
    const customRatings = getCustomRatings(profile);
    Object.keys(customRatings).forEach(compId => {
      const v = ((customRatings[compId] || {}).trade || {})[period];
      if (typeof v === 'number') existing[compId] = v;
    });
    let gridHtml = '';
    effective.forEach(comp => {
      const attr = _compAttr(comp.id);
      const current = existing[String(comp.id)] || 0;
      gridHtml += '<div style="padding:12px 0;border-bottom:1px solid var(--border)">';
      gridHtml += '<div style="font-size:13px;font-weight:600;color:var(--navy);margin-bottom:6px;display:flex;align-items:center;gap:6px">';
      if (comp._custom) {
        gridHtml += '<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:#EEF2FF;color:#4338CA">✨ custom</span>';
      }
      gridHtml += esc(comp.name) + '</div>';
      gridHtml += '<div style="display:flex;gap:2px" data-comp-id="' + attr + '">';
      for (let i = 1; i <= 5; i++) {
        gridHtml += '<button class="tr-star" data-comp="' + attr + '" data-val="' + i + '" onclick="setTRStarRating(this,\'' + attr + '\',' + i + ')" style="background:none;border:none;cursor:pointer;font-size:28px;padding:3px 5px;color:' + (i <= current ? '#F59E0B' : '#E5E7EB') + ';transition:color .1s;min-width:40px;min-height:40px;display:flex;align-items:center;justify-content:center">★</button>';
      }
      gridHtml += '</div></div>';
    });
    document.getElementById('tr-competencies-grid').innerHTML = gridHtml;
  };

  buildGrid(getCurrentPeriod());

  // Rebuild grid when period changes
  const periodEl = document.getElementById('tr-period');
  if (periodEl) periodEl.onchange = function() { buildGrid(this.value); };

  openModal('modal-apprentice-trade-rating');
}

function setTRStarRating(btn, attrId, val) {
  const container = btn.closest('[data-comp-id="' + attrId + '"]');
  if (!container) return;
  container.querySelectorAll('.tr-star[data-comp="' + attrId + '"]').forEach((s, i) => {
    s.style.color = i < val ? '#F59E0B' : '#E5E7EB';
  });
}

async function submitTradesmanRating() {
  const profileId = document.getElementById('tr-apprentice-id').value;
  const ratedBy = document.getElementById('tr-rated-by').value.trim();
  const period = document.getElementById('tr-period').value;
  if (!ratedBy) { showToast('Enter your name'); return; }
  if (!period) { showToast('Select a period'); return; }
  const profile = apprenticeProfiles.find(p => String(p.id) === String(profileId));
  if (!profile) return;

  const effective = getEffectiveCompetencies(profile);
  const ratingRows = [];
  const customUpdates = {};
  effective.forEach(comp => {
    const attr = _compAttr(comp.id);
    const container = document.querySelector('#tr-competencies-grid [data-comp-id="' + attr + '"]');
    if (!container) return;
    const stars = container.querySelectorAll('.tr-star[data-comp="' + attr + '"]');
    let rating = 0;
    stars.forEach((s, i) => { if (s.style.color === 'rgb(245, 158, 11)') rating = i + 1; });
    if (rating <= 0) return;
    if (comp._custom) {
      customUpdates[comp.id] = rating;
    } else {
      ratingRows.push({ competency_id: comp.id, rating, period, rating_type: 'tradesman', rated_by: ratedBy, apprentice_id: profileId, org_id: TENANT.ORG_UUID });
    }
  });

  if (!ratingRows.length && !Object.keys(customUpdates).length) {
    showToast('Rate at least one competency'); return;
  }

  try {
    if (ratingRows.length) {
      // Same as the self-rating path above — sbFetch handles
      // TENANT_DISABLED_TABLES + offline queue + error throwing.
      await sbFetch('skills_ratings', 'POST', ratingRows, 'resolution=merge-duplicates,return=minimal');
    }

    if (Object.keys(customUpdates).length) {
      const merged = Object.assign({}, getCustomRatings(profile));
      Object.keys(customUpdates).forEach(compId => {
        if (!merged[compId]) merged[compId] = {};
        if (!merged[compId].trade) merged[compId].trade = {};
        merged[compId].trade[period] = customUpdates[compId];
      });
      await sbFetch('apprentice_profiles?id=eq.' + profileId, 'PATCH', {
        custom_ratings: merged,
        updated_at: new Date().toISOString(),
      });
      profile.custom_ratings = merged;
    }

    showToast('Ratings saved ✓');
    closeModal('modal-apprentice-trade-rating');
    await loadApprenticeData();
    renderApprenticeProfile(profileId);
  } catch(e) {
    showToast('Save failed — ' + (e.message || 'check connection'));
  }
}

// ── Add Rotation ──────────────────────────────────────────────

function openAddRotation(profileId, personName) {
  if (!isManager) { showToast('Supervision access required'); return; }
  const modal = document.getElementById('modal-apprentice-rotation');
  if (!modal) return;
  document.getElementById('rot-apprentice-id').value = profileId;
  document.getElementById('rot-type').value = 'Commercial';
  document.getElementById('rot-start').value = new Date().toISOString().slice(0, 10);
  document.getElementById('rot-end').value = '';
  document.getElementById('rot-main-work').value = '';
  document.getElementById('modal-rot-title').textContent = 'Add Rotation — ' + personName;

  // Site/job combobox
  const siteWrap = document.getElementById('rot-site-wrap');
  if (siteWrap) siteWrap.innerHTML = jobComboHtml('rot-site', 'Job number or site', '');

  // Supervisor combobox
  const supWrap = document.getElementById('rot-supervisor-wrap');
  if (supWrap) supWrap.innerHTML = nameComboHtml('rot-supervisor', 'Supervisor name', '');

  openModal('modal-apprentice-rotation');
}

async function saveRotation() {
  const profileId = document.getElementById('rot-apprentice-id').value;
  const site = document.getElementById('rot-site').value.trim();
  const type = document.getElementById('rot-type').value;
  const start = document.getElementById('rot-start').value;
  const end = document.getElementById('rot-end').value || null;
  const supervisor = document.getElementById('rot-supervisor').value.trim();
  const mainWork = document.getElementById('rot-main-work').value.trim();

  if (!site) { showToast('Enter a site or job number'); return; }
  if (!start) { showToast('Enter a start date'); return; }

  const row = {
    apprentice_id: profileId,
    org_id: TENANT.ORG_UUID,
    project_site: site,
    project_type: type || 'Other',
    date_start: start,
    date_end: end,
    supervisor: supervisor || null,
    main_work: mainWork || null,
  };

  try {
    const res = await sbFetch('rotations', 'POST', row, 'return=representation');
    const newRot = res && res[0];
    if (newRot) apprenticeRotations.unshift(newRot);
    showToast('Rotation added ✓');
    closeModal('modal-apprentice-rotation');
    await loadApprenticeData();
    renderApprenticeProfile(profileId);
  } catch(e) {
    showToast('Save failed — check connection');
  }
}