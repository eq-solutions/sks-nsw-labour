/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/teams.js  —  EQ Solves Field (v3.4.78)
// Teams = named, coloured filter groups for the roster.
//   • Many-to-many — a person can sit in multiple teams.
//   • Pure view metadata; does NOT affect availability or scheduling.
//   • Filter persists per-browser via localStorage so a refresh
//     remembers which team you were looking at.
// Depends on: app-state.js, utils.js, supabase.js
//
// Field request: Ben Ritchie — "make rostering easier to navigate
// by letting supervisors see just their crew."
// ─────────────────────────────────────────────────────────────

const TEAMS_FILTER_LS_KEY = 'eq.teams.currentFilter';

// ── Restore filter from localStorage ────────────────────────
// Run synchronously at module load so the first roster render
// already filters to the supervisor's last-used team.
// Stored as a JSON array of IDs (supports multi-select). Older
// single-ID values (plain number string) are silently dropped.
(function _restoreTeamFilter() {
  try {
    const raw = localStorage.getItem(TEAMS_FILTER_LS_KEY);
    if (raw && raw !== 'null' && raw !== 'undefined') {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        STATE.teamFilters = new Set(parsed);
      }
    }
  } catch (e) {}
})();

function _persistTeamFilter() {
  try {
    const filters = STATE.teamFilters;
    if (!filters || !filters.size) {
      localStorage.removeItem(TEAMS_FILTER_LS_KEY);
    } else {
      localStorage.setItem(TEAMS_FILTER_LS_KEY, JSON.stringify([...filters]));
    }
  } catch (e) {}
}

// ── Membership lookups ──────────────────────────────────────
// Cache person_id Sets per team for fast lookup.
let _membershipCache = {};

function _peopleInTeam(teamId) {
  if (teamId == null) return null;
  if (_membershipCache[teamId]) return _membershipCache[teamId];
  const set = new Set();
  (STATE.teamMembers || []).forEach(m => {
    if (m.team_id === teamId) set.add(m.person_id);
  });
  _membershipCache[teamId] = set;
  return set;
}

function _invalidateMembershipCache() {
  _membershipCache = {};
}

// Public: should a person row be visible given the current filter?
// Used by renderRoster, renderContacts, renderTimesheets.
// Multi-select: person must belong to ALL selected teams (intersection / slicer behaviour).
function personInActiveTeam(personId) {
  const filters = STATE.teamFilters;
  if (!filters || !filters.size) return true;  // no filter = show all

  // "Unassigned" pseudo-team: only meaningful when selected alone.
  // If mixed with real teams, skip the unassigned check (impossible intersection).
  const realTeams = [...filters].filter(id => id !== -1);

  if (filters.has(-1) && realTeams.length === 0) {
    const memberIds = new Set((STATE.teamMembers || []).map(m => m.person_id));
    return !memberIds.has(personId);
  }

  // Real teams: pass only if person is in EVERY selected team
  for (const teamId of realTeams) {
    const set = _peopleInTeam(teamId);
    if (!set || !set.has(personId)) return false;
  }
  return true;
}

// Public: returns the colour to use for a person's row stripe.
// Exactly one team selected → use that team's colour.
// Multiple selected or none → use first team person belongs to alphabetically.
function colorForPerson(personId) {
  const filters = STATE.teamFilters;
  if (filters && filters.size === 1) {
    const [onlyId] = filters;
    if (onlyId !== -1) {
      const t = (STATE.teams || []).find(x => x.id === onlyId);
      return t ? t.color : null;
    }
  }
  // No filter or multi-select — first team alphabetically
  const personTeams = (STATE.teamMembers || [])
    .filter(m => m.person_id === personId)
    .map(m => (STATE.teams || []).find(t => t.id === m.team_id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  return personTeams[0] ? personTeams[0].color : null;
}

// ── Filter pill row ─────────────────────────────────────────
// Rendered into <div id="teams-filter-row"> which sits between the
// topbar and the page content. Visible on roster + contacts only.
function renderTeamPills() {
  const row = document.getElementById('teams-filter-row');
  if (!row) return;

  // Only show on roster / contacts pages. The page-change handler
  // toggles row visibility; this just guards against a stale render.
  if (currentPage !== 'roster' && currentPage !== 'contacts' && currentPage !== 'schedule' && currentPage !== 'timesheets') {
    row.style.display = 'none';
    return;
  }
  // Teams filter is a supervisor tool — employees on My Schedule don't need it.
  if (currentPage === 'schedule' && typeof isManager !== 'undefined' && !isManager) {
    row.style.display = 'none';
    return;
  }
  row.style.display = '';

  const teams   = (STATE.teams || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const filters = STATE.teamFilters || new Set();

  // Unassigned count for the pseudo-team pill
  const memberIds = new Set((STATE.teamMembers || []).map(m => m.person_id));
  const unassignedCount = (STATE.people || [])
    .filter(p => !p.archived && !memberIds.has(p.id))
    .length;

  // Helper to render a pill — active pills show a ✕ to indicate they can be toggled off
  const pill = (label, teamId, color, count, isActive) => {
    const bg     = isActive ? (color || '#7C77B9') : '#F1F5F9';
    const fg     = isActive ? '#FFFFFF'             : '#1F335C';
    const border = isActive ? (color || '#7C77B9') : '#CBD5E1';
    const idAttr = teamId == null ? 'null' : String(teamId);
    const swatch = (teamId != null && teamId !== -1 && color)
      ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle;${isActive ? 'background:rgba(255,255,255,.95)' : ''}"></span>`
      : '';
    const countTxt = count != null ? ` <span style="opacity:.7;font-weight:500">(${count})</span>` : '';
    const closeMark = isActive && teamId != null ? ` <span style="margin-left:5px;opacity:.75;font-size:10px">✕</span>` : '';
    return `<button type="button" onclick="setTeamFilter(${idAttr})"
      style="display:inline-flex;align-items:center;background:${bg};color:${fg};border:1px solid ${border};border-radius:14px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;margin-right:6px;margin-bottom:4px;white-space:nowrap"
      title="${esc(label)}${count != null ? ' — ' + count + ' people' : ''}">${swatch}${esc(label)}${countTxt}${closeMark}</button>`;
  };

  let html = '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:0;padding:8px 18px;background:var(--surface-2);border-bottom:1px solid var(--border)">';
  html += '<span style="font-size:10px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-right:10px;flex-shrink:0">Team</span>';

  // "All" pill — active when no filters are set; clicking clears all filters
  const totalActive = (STATE.people || []).filter(p => !p.archived).length;
  html += pill('All', null, null, totalActive, !filters.size);

  // Per-team pills
  teams.forEach(t => {
    const cnt = _peopleInTeam(t.id);
    html += pill(t.name, t.id, t.color, cnt ? cnt.size : 0, filters.has(t.id));
  });

  // "Unassigned" pseudo-team — only show if there are any
  if (unassignedCount > 0) {
    html += pill('Unassigned', -1, '#94A3B8', unassignedCount, filters.has(-1));
  }

  // Manage button (supervisor only)
  if (typeof isManager !== 'undefined' && isManager) {
    html += `<button type="button" onclick="openManageTeams()"
      style="display:inline-flex;align-items:center;background:transparent;color:var(--ink-2);border:1px dashed #CBD5E1;border-radius:14px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;margin-left:auto;margin-bottom:4px;white-space:nowrap"
      title="Create, rename, or delete teams">⚙ Manage teams</button>`;
  }

  html += '</div>';
  row.innerHTML = html;
}

// Public: toggle a team in/out of the active filter set.
//   null  — clear all filters (show All)
//   -1    — toggle Unassigned pseudo-team
//   N     — toggle a specific team id on/off
function setTeamFilter(teamId) {
  if (!STATE.teamFilters) STATE.teamFilters = new Set();
  if (teamId == null) {
    // "All" pill — clear everything
    STATE.teamFilters.clear();
  } else {
    if (STATE.teamFilters.has(teamId)) {
      STATE.teamFilters.delete(teamId);
    } else {
      STATE.teamFilters.add(teamId);
    }
  }
  _invalidateMembershipCache();
  _persistTeamFilter();
  renderTeamPills();
  if (typeof renderCurrentPage === 'function') renderCurrentPage();
}

// ── Manage Teams modal ──────────────────────────────────────
let _editingTeamId = null;  // null = create-mode; team id = edit-mode

async function openManageTeams() {
  if (!isManager) { showToast('Supervision access required'); return; }
  _editingTeamId = null;
  openModal('modal-manage-teams');
  renderManageTeamsModal();
}

function renderManageTeamsModal() {
  const body = document.getElementById('manage-teams-body');
  if (!body) return;

  const teams = (STATE.teams || []).slice().sort((a, b) => a.name.localeCompare(b.name));

  // ── List of existing teams ────────────────────────────────
  let listHtml = '';
  if (!teams.length) {
    listHtml = '<div class="empty" style="padding:24px 8px;text-align:center"><div class="empty-icon">👥</div><p>No teams yet — create one below.</p></div>';
  } else {
    listHtml = '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">';
    teams.forEach(t => {
      const memberCount = (STATE.teamMembers || []).filter(m => m.team_id === t.id).length;
      const isEditing   = _editingTeamId === t.id;
      listHtml += `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border);background:${isEditing ? 'var(--surface-2)' : 'transparent'}">
        <span style="width:14px;height:14px;border-radius:4px;background:${t.color};flex-shrink:0"></span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--navy)">${esc(t.name)}</div>
          <div style="font-size:11px;color:var(--ink-3)">${memberCount} ${memberCount === 1 ? 'person' : 'people'}</div>
        </div>
        <button onclick="startEditTeam(${t.id})" class="btn btn-secondary btn-sm" style="font-size:11px" ${isEditing ? 'disabled' : ''}>${isEditing ? 'Editing' : '✎ Edit'}</button>
        <button onclick="confirmDeleteTeam(${t.id})" class="btn btn-secondary btn-sm" style="font-size:11px;color:var(--red)" title="Delete team">🗑</button>
      </div>`;
    });
    listHtml += '</div>';
  }

  // ── Create new team form ──────────────────────────────────
  const createHtml = `
    <div style="margin-top:18px;padding:14px;background:var(--surface-2);border-radius:8px">
      <div style="font-size:11px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Add a new team</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="new-team-name" type="text" placeholder="Team name (e.g. Equinix Crew)"
          style="flex:1;min-width:180px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px"
          maxlength="60">
        <input id="new-team-color" type="color" value="#7C77B9"
          style="width:44px;height:38px;border:1px solid var(--border);border-radius:6px;padding:2px;cursor:pointer;background:white">
        <button onclick="createTeamFromForm()" class="btn btn-primary btn-sm" style="font-size:12px">Create</button>
      </div>
    </div>`;

  // ── Edit panel (for the selected team) ────────────────────
  let editHtml = '';
  if (_editingTeamId != null) {
    const team = teams.find(t => t.id === _editingTeamId);
    if (team) {
      const members = new Set(
        (STATE.teamMembers || [])
          .filter(m => m.team_id === team.id)
          .map(m => m.person_id)
      );
      const peopleSorted = (STATE.people || [])
        .filter(p => !p.archived)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));

      editHtml = `
        <div style="margin-top:18px;padding:14px;background:var(--purple-lt);border-radius:8px;border:1px solid rgba(124,119,185,.3)">
          <div style="font-size:11px;font-weight:700;color:var(--purple);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Editing: ${esc(team.name)}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
            <input id="edit-team-name" type="text" value="${esc(team.name)}"
              style="flex:1;min-width:180px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-family:inherit;font-size:13px"
              maxlength="60">
            <input id="edit-team-color" type="color" value="${esc(team.color || '#7C77B9')}"
              style="width:44px;height:38px;border:1px solid var(--border);border-radius:6px;padding:2px;cursor:pointer;background:white">
          </div>
          <div style="font-size:11px;font-weight:700;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Members (${members.size} of ${peopleSorted.length})</div>
          <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;background:white">
            ${peopleSorted.map(p => {
              const checked = members.has(p.id) ? 'checked' : '';
              return `<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px">
                <input type="checkbox" data-person-id="${p.id}" ${checked} class="edit-team-member-cb" style="width:16px;height:16px;cursor:pointer">
                <span style="flex:1">${esc(p.name)}</span>
                <span style="font-size:10px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.5px">${esc(p.group || '')}</span>
              </label>`;
            }).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
            <button onclick="cancelEditTeam()" class="btn btn-secondary btn-sm" style="font-size:12px">Cancel</button>
            <button onclick="saveEditTeam()" class="btn btn-primary btn-sm" style="font-size:12px">Save changes</button>
          </div>
        </div>`;
    }
  }

  body.innerHTML = listHtml + createHtml + editHtml;
}

function startEditTeam(teamId) {
  _editingTeamId = teamId;
  renderManageTeamsModal();
  // Scroll the edit panel into view
  setTimeout(() => {
    const body = document.getElementById('manage-teams-body');
    if (body) body.scrollTop = body.scrollHeight;
  }, 30);
}

function cancelEditTeam() {
  _editingTeamId = null;
  renderManageTeamsModal();
}

async function createTeamFromForm() {
  const nameEl  = document.getElementById('new-team-name');
  const colorEl = document.getElementById('new-team-color');
  const name    = (nameEl.value || '').trim();
  const color   = (colorEl.value || '#7C77B9').toLowerCase();
  if (!name) { showToast('Please give the team a name'); nameEl.focus(); return; }
  if (name.length > 60) { showToast('Team name max 60 chars'); return; }

  // Local duplicate check (server enforces UNIQUE org_id+name too)
  if ((STATE.teams || []).some(t => t.name.toLowerCase() === name.toLowerCase())) {
    showToast('A team with that name already exists');
    return;
  }

  try {
    const res = await sbFetch('teams', 'POST', { name, color }, 'return=representation');
    if (res && res[0]) {
      STATE.teams = STATE.teams || [];
      STATE.teams.push({ id: res[0].id, name: res[0].name, color: res[0].color });
      _invalidateMembershipCache();
      auditLog('Team created: ' + name, 'Teams', color, null);
      showToast('Team created — ' + name);
      // Auto-open the edit panel so the supervisor can add people next.
      _editingTeamId = res[0].id;
      renderManageTeamsModal();
      renderTeamPills();
    }
  } catch (e) {
    showToast('Could not create team: ' + (e && e.message || e));
  }
}

async function saveEditTeam() {
  if (_editingTeamId == null) return;
  const team = (STATE.teams || []).find(t => t.id === _editingTeamId);
  if (!team) { _editingTeamId = null; renderManageTeamsModal(); return; }

  const nameEl  = document.getElementById('edit-team-name');
  const colorEl = document.getElementById('edit-team-color');
  const name    = (nameEl.value || '').trim();
  const color   = (colorEl.value || team.color || '#7C77B9').toLowerCase();
  if (!name) { showToast('Please give the team a name'); nameEl.focus(); return; }

  // Compute member diff
  const desired = new Set();
  document.querySelectorAll('.edit-team-member-cb').forEach(cb => {
    if (cb.checked) {
      const pid = Number(cb.dataset.personId);
      if (!isNaN(pid)) desired.add(pid);
    }
  });
  const current = new Set(
    (STATE.teamMembers || [])
      .filter(m => m.team_id === team.id)
      .map(m => m.person_id)
  );
  const toAdd    = [...desired].filter(id => !current.has(id));
  const toRemove = [...current].filter(id => !desired.has(id));

  try {
    // Patch the team metadata if changed
    if (name !== team.name || color !== (team.color || '').toLowerCase()) {
      await sbFetch('teams?id=eq.' + team.id, 'PATCH', { name, color });
      team.name  = name;
      team.color = color;
    }

    // Add new members (batched POST)
    if (toAdd.length) {
      const rows = toAdd.map(pid => ({ team_id: team.id, person_id: pid }));
      await sbFetch('team_members', 'POST', rows);
      toAdd.forEach(pid => {
        STATE.teamMembers = STATE.teamMembers || [];
        STATE.teamMembers.push({ team_id: team.id, person_id: pid });
      });
    }

    // Remove dropped members (one DELETE per — small N typical)
    for (const pid of toRemove) {
      await sbFetch('team_members?team_id=eq.' + team.id + '&person_id=eq.' + pid, 'DELETE');
      STATE.teamMembers = (STATE.teamMembers || []).filter(m => !(m.team_id === team.id && m.person_id === pid));
    }

    _invalidateMembershipCache();
    auditLog('Team updated: ' + name, 'Teams',
      `+${toAdd.length} / −${toRemove.length} member changes`, null);
    showToast('Saved — ' + name);
    _editingTeamId = null;
    renderManageTeamsModal();
    renderTeamPills();
    if (typeof renderCurrentPage === 'function') renderCurrentPage();
  } catch (e) {
    showToast('Could not save team: ' + (e && e.message || e));
  }
}

function confirmDeleteTeam(teamId) {
  const team = (STATE.teams || []).find(t => t.id === teamId);
  if (!team) return;
  const memberCount = (STATE.teamMembers || []).filter(m => m.team_id === teamId).length;
  const msg = memberCount
    ? `Delete "${team.name}"? Its ${memberCount} member${memberCount === 1 ? '' : 's'} won't be deleted — only the team itself goes.`
    : `Delete "${team.name}"?`;
  if (!confirm(msg)) return;
  deleteTeam(teamId);
}

async function deleteTeam(teamId) {
  const team = (STATE.teams || []).find(t => t.id === teamId);
  if (!team) return;
  try {
    // team_members rows go via ON DELETE CASCADE in the DB.
    await sbFetch('teams?id=eq.' + teamId, 'DELETE');
    STATE.teams       = (STATE.teams || []).filter(t => t.id !== teamId);
    STATE.teamMembers = (STATE.teamMembers || []).filter(m => m.team_id !== teamId);
    if (STATE.teamFilters && STATE.teamFilters.has(teamId)) {
      STATE.teamFilters.delete(teamId);
      _persistTeamFilter();
    }
    _invalidateMembershipCache();
    auditLog('Team deleted: ' + team.name, 'Teams', null, null);
    showToast('Deleted — ' + team.name);
    if (_editingTeamId === teamId) _editingTeamId = null;
    renderManageTeamsModal();
    renderTeamPills();
    if (typeof renderCurrentPage === 'function') renderCurrentPage();
  } catch (e) {
    showToast('Could not delete team: ' + (e && e.message || e));
  }
}
