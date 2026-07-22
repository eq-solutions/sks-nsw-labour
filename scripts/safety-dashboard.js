/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// scripts/safety-dashboard.js  —  EQ Solves Field
// Safety compliance dashboard: prestart + toolbox completion
// counts by person and site. Manager-only.
// Depends on: app-state.js, utils.js, supabase.js
// ─────────────────────────────────────────────────────────────

let _sdPrestarts = [];
let _sdToolboxes = [];
let _sdIncidents = [];
let _sdRange     = 30; // days lookback: 7 | 30 | 90 | 0 = all

function _sdIsoMinus(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function _sdFmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return d + '/' + m + '/' + y.slice(2);
}

function _sdBar(signed, total) {
  if (!total) return '';
  const pct   = Math.round(signed / total * 100);
  const color = pct >= 100 ? 'var(--green)' : pct >= 70 ? 'var(--amber)' : 'var(--red)';
  return '<span style="display:inline-block;width:36px;height:6px;background:var(--border);border-radius:3px;vertical-align:middle;overflow:hidden;margin-right:4px">'
    + '<span style="display:block;width:' + pct + '%;height:100%;background:' + color + ';border-radius:3px"></span>'
    + '</span>';
}

function _sdCard(title, body) {
  return '<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:14px">'
    + '<div style="padding:9px 12px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:12px;font-weight:700">' + title + '</div>'
    + body
    + '</div>';
}

function sdSetRange(days) {
  _sdRange = days;
  loadSafetyDashboard();
}

async function loadSafetyDashboard() {
  const el = document.getElementById('page-safety-dashboard');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:48px 20px;color:var(--ink-3);font-size:13px">Loading…</div>';

  const cutoff = _sdRange > 0 ? _sdIsoMinus(_sdRange) : null;
  const psQ = 'prestarts?select=*&order=briefing_date.desc&limit=500'
    + (cutoff ? '&briefing_date=gte.' + cutoff : '');
  const tbQ = 'toolbox_talks?select=*&order=meeting_date.desc&limit=500'
    + (cutoff ? '&meeting_date=gte.' + cutoff : '');
  const incQ = 'incidents?select=*&order=incident_date.desc&limit=500'
    + (cutoff ? '&incident_date=gte.' + cutoff : '');

  try {
    const [ps, tb, inc] = await Promise.all([
      sbFetch(psQ).catch(function() { return []; }),
      sbFetch(tbQ).catch(function() { return []; }),
      sbFetch(incQ).catch(function() { return []; })
    ]);
    _sdPrestarts = Array.isArray(ps) ? ps : [];
    _sdToolboxes = Array.isArray(tb) ? tb : [];
    _sdIncidents = Array.isArray(inc) ? inc : [];
  } catch(e) {
    _sdPrestarts = [];
    _sdToolboxes = [];
    _sdIncidents = [];
  }
  renderSafetyDashboard();
}

function renderSafetyDashboard() {
  const el = document.getElementById('page-safety-dashboard');
  if (!el) return;

  const subPS   = _sdPrestarts.filter(function(r) { return r.status === 'submitted'; });
  const subTB   = _sdToolboxes.filter(function(r) { return r.status === 'submitted'; });
  const subINC  = _sdIncidents.filter(function(r) { return r.status === 'submitted'; });
  const draftPS = _sdPrestarts.filter(function(r) { return r.status !== 'submitted'; });
  const draftTB = _sdToolboxes.filter(function(r) { return r.status !== 'submitted'; });
  const draftINC = _sdIncidents.filter(function(r) { return r.status !== 'submitted'; });

  // ── Stats ──────────────────────────────────────────────────────
  const totalPS  = subPS.length;
  const totalTB  = subTB.length;
  const totalINC = subINC.length;
  const highINC  = subINC.filter(function(r) { return r.severity === 'high'; }).length;

  const allSites = new Set();
  subPS.forEach(function(r) { if (r.site_abbr) allSites.add(r.site_abbr); });
  subTB.forEach(function(r) { if (r.site_abbr) allSites.add(r.site_abbr); });
  subINC.forEach(function(r) { if (r.site_abbr) allSites.add(r.site_abbr); });

  const totalSignoffs =
    subPS.reduce(function(n, r) { return n + (r.crew || []).filter(function(c) { return c.signed_at; }).length; }, 0) +
    subTB.reduce(function(n, r) { return n + (r.attendance || []).filter(function(c) { return c.signed_at; }).length; }, 0);

  // ── By-person: prestarts ───────────────────────────────────────
  const byPersonPS = {};
  subPS.forEach(function(r) {
    const who = r.sks_rep || r.submitted_by || r.created_by || 'Unknown';
    if (!byPersonPS[who]) byPersonPS[who] = { count: 0, lastDate: '', signed: 0, crew: 0, sites: new Set() };
    byPersonPS[who].count++;
    if ((r.briefing_date || '') > byPersonPS[who].lastDate) byPersonPS[who].lastDate = r.briefing_date || '';
    byPersonPS[who].signed += (r.crew || []).filter(function(c) { return c.signed_at; }).length;
    byPersonPS[who].crew   += (r.crew || []).length;
    if (r.site_abbr) byPersonPS[who].sites.add(r.site_abbr);
  });

  // ── By-person: toolboxes ───────────────────────────────────────
  const byPersonTB = {};
  subTB.forEach(function(r) {
    const who = r.facilitator || r.submitted_by || r.created_by || 'Unknown';
    if (!byPersonTB[who]) byPersonTB[who] = { count: 0, lastDate: '', signed: 0, att: 0, sites: new Set() };
    byPersonTB[who].count++;
    if ((r.meeting_date || '') > byPersonTB[who].lastDate) byPersonTB[who].lastDate = r.meeting_date || '';
    byPersonTB[who].signed += (r.attendance || []).filter(function(c) { return c.signed_at; }).length;
    byPersonTB[who].att    += (r.attendance || []).length;
    if (r.site_abbr) byPersonTB[who].sites.add(r.site_abbr);
  });

  // ── By-person: incidents ────────────────────────────────────────
  const byPersonINC = {};
  subINC.forEach(function(r) {
    const who = r.reported_by || r.submitted_by || r.created_by || 'Unknown';
    if (!byPersonINC[who]) byPersonINC[who] = { count: 0, high: 0, lastDate: '', sites: new Set() };
    byPersonINC[who].count++;
    if (r.severity === 'high') byPersonINC[who].high++;
    if ((r.incident_date || '') > byPersonINC[who].lastDate) byPersonINC[who].lastDate = r.incident_date || '';
    if (r.site_abbr) byPersonINC[who].sites.add(r.site_abbr);
  });

  // ── By-site ────────────────────────────────────────────────────
  const bySite = {};
  subPS.forEach(function(r) {
    const s = r.site_abbr || '—';
    if (!bySite[s]) bySite[s] = { ps: 0, tb: 0, inc: 0 };
    bySite[s].ps++;
  });
  subTB.forEach(function(r) {
    const s = r.site_abbr || '—';
    if (!bySite[s]) bySite[s] = { ps: 0, tb: 0, inc: 0 };
    bySite[s].tb++;
  });
  subINC.forEach(function(r) {
    const s = r.site_abbr || '—';
    if (!bySite[s]) bySite[s] = { ps: 0, tb: 0, inc: 0 };
    bySite[s].inc++;
  });

  // ── Render ─────────────────────────────────────────────────────
  let h = '';

  // Header + range filter
  h += '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px">';
  h += '<div style="font-size:15px;font-weight:700">Safety Report</div>';
  h += '<div style="display:flex;gap:5px">';
  [[7,'7d'],[30,'30d'],[90,'90d'],[0,'All']].forEach(function(pair) {
    const d = pair[0], lbl = pair[1], active = _sdRange === d;
    h += '<button onclick="sdSetRange(' + d + ')" style="padding:4px 10px;border-radius:999px;border:1.5px solid '
      + (active ? 'var(--blue)' : 'var(--border)') + ';background:'
      + (active ? 'var(--blue)' : 'var(--surface)') + ';color:'
      + (active ? 'white' : 'var(--ink-3)') + ';font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s">'
      + lbl + '</button>';
  });
  h += '</div></div>';

  // Stat cards
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px">';
  [
    { label: 'Prestarts submitted', value: totalPS, color: 'var(--blue)',   sub: draftPS.length ? draftPS.length + ' draft' : '' },
    { label: 'Toolbox talks submitted', value: totalTB, color: 'var(--green)',  sub: draftTB.length ? draftTB.length + ' draft' : '' },
    { label: 'Incidents reported', value: totalINC, color: '#dc2626', sub: (highINC ? highINC + ' high sev' : '') + (draftINC.length ? (highINC ? ' · ' : '') + draftINC.length + ' draft' : '') },
    { label: 'Sites covered', value: allSites.size, color: 'var(--amber)',  sub: '' },
    { label: 'Total sign-offs', value: totalSignoffs, color: 'var(--ink-2)', sub: '' },
  ].forEach(function(c) {
    h += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">';
    h += '<div style="font-size:28px;font-weight:800;color:' + c.color + ';line-height:1;letter-spacing:-1px">' + c.value + '</div>';
    h += '<div style="font-size:11px;color:var(--ink-3);margin-top:4px;font-weight:600;text-transform:uppercase;letter-spacing:.3px">' + c.label + '</div>';
    if (c.sub) h += '<div style="font-size:10px;color:var(--ink-4);margin-top:2px">' + esc(c.sub) + '</div>';
    h += '</div>';
  });
  h += '</div>';

  // ── Prestarts by person ────────────────────────────────────────
  const psRows = Object.entries(byPersonPS).sort(function(a, b) { return b[1].count - a[1].count; });
  h += _sdCard('🛡 Prestarts — by person (' + psRows.length + ')',
    psRows.length === 0
      ? '<div style="padding:20px;text-align:center;color:var(--ink-3);font-size:12px">No submitted prestarts in this period.</div>'
      : (function() {
          const TH = 'padding:8px 12px;text-align:left;font-weight:700;color:var(--ink-3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;border-bottom:1px solid var(--border)';
          let t = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">';
          t += '<thead><tr style="background:var(--surface-2)">';
          t += '<th style="' + TH + '">Name</th>';
          t += '<th style="' + TH + ';text-align:center">Prestarts</th>';
          t += '<th style="' + TH + ';text-align:center">Crew sign-off</th>';
          t += '<th style="' + TH + '">Sites</th>';
          t += '<th style="' + TH + ';text-align:right">Last</th>';
          t += '</tr></thead><tbody>';
          psRows.forEach(function(row, i) {
            const name = row[0], d = row[1];
            const bg       = i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)';
            const signPct  = d.crew > 0 ? Math.round(d.signed / d.crew * 100) + '%' : '—';
            const siteList = Array.from(d.sites).join(', ') || '—';
            t += '<tr style="background:' + bg + ';border-bottom:1px solid var(--border)">';
            t += '<td style="padding:9px 12px;font-weight:600;white-space:nowrap">' + esc(name) + '</td>';
            t += '<td style="padding:9px 12px;text-align:center"><span style="background:var(--blue-lt);color:var(--blue);padding:2px 9px;border-radius:999px;font-weight:700;font-size:11px">' + d.count + '</span></td>';
            t += '<td style="padding:9px 12px;text-align:center;white-space:nowrap">' + (d.crew > 0 ? _sdBar(d.signed, d.crew) : '') + '<span style="font-size:11px;color:var(--ink-3)">' + signPct + '</span></td>';
            t += '<td style="padding:9px 12px;color:var(--ink-3);font-size:11px">' + esc(siteList) + '</td>';
            t += '<td style="padding:9px 12px;text-align:right;color:var(--ink-4);font-size:11px;white-space:nowrap">' + _sdFmtDate(d.lastDate) + '</td>';
            t += '</tr>';
          });
          t += '</tbody></table></div>';
          return t;
        })()
  );

  // ── Toolboxes by person ────────────────────────────────────────
  const tbRows = Object.entries(byPersonTB).sort(function(a, b) { return b[1].count - a[1].count; });
  h += _sdCard('📋 Toolbox talks — by person (' + tbRows.length + ')',
    tbRows.length === 0
      ? '<div style="padding:20px;text-align:center;color:var(--ink-3);font-size:12px">No submitted toolbox talks in this period.</div>'
      : (function() {
          const TH = 'padding:8px 12px;text-align:left;font-weight:700;color:var(--ink-3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;border-bottom:1px solid var(--border)';
          let t = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">';
          t += '<thead><tr style="background:var(--surface-2)">';
          t += '<th style="' + TH + '">Name</th>';
          t += '<th style="' + TH + ';text-align:center">Talks</th>';
          t += '<th style="' + TH + ';text-align:center">Attendance sign-off</th>';
          t += '<th style="' + TH + '">Sites</th>';
          t += '<th style="' + TH + ';text-align:right">Last</th>';
          t += '</tr></thead><tbody>';
          tbRows.forEach(function(row, i) {
            const name = row[0], d = row[1];
            const bg       = i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)';
            const signPct  = d.att > 0 ? Math.round(d.signed / d.att * 100) + '%' : '—';
            const siteList = Array.from(d.sites).join(', ') || '—';
            t += '<tr style="background:' + bg + ';border-bottom:1px solid var(--border)">';
            t += '<td style="padding:9px 12px;font-weight:600;white-space:nowrap">' + esc(name) + '</td>';
            t += '<td style="padding:9px 12px;text-align:center"><span style="background:var(--green-lt);color:var(--green);padding:2px 9px;border-radius:999px;font-weight:700;font-size:11px">' + d.count + '</span></td>';
            t += '<td style="padding:9px 12px;text-align:center;white-space:nowrap">' + (d.att > 0 ? _sdBar(d.signed, d.att) : '') + '<span style="font-size:11px;color:var(--ink-3)">' + signPct + '</span></td>';
            t += '<td style="padding:9px 12px;color:var(--ink-3);font-size:11px">' + esc(siteList) + '</td>';
            t += '<td style="padding:9px 12px;text-align:right;color:var(--ink-4);font-size:11px;white-space:nowrap">' + _sdFmtDate(d.lastDate) + '</td>';
            t += '</tr>';
          });
          t += '</tbody></table></div>';
          return t;
        })()
  );

  // ── Incidents by person ────────────────────────────────────────
  const incRows = Object.entries(byPersonINC).sort(function(a, b) { return b[1].count - a[1].count; });
  h += _sdCard('⚠ Incidents / near misses — by person (' + incRows.length + ')',
    incRows.length === 0
      ? '<div style="padding:20px;text-align:center;color:var(--ink-3);font-size:12px">No submitted incidents in this period.</div>'
      : (function() {
          const TH = 'padding:8px 12px;text-align:left;font-weight:700;color:var(--ink-3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;border-bottom:1px solid var(--border)';
          let t = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">';
          t += '<thead><tr style="background:var(--surface-2)">';
          t += '<th style="' + TH + '">Name</th>';
          t += '<th style="' + TH + ';text-align:center">Reports</th>';
          t += '<th style="' + TH + ';text-align:center">High severity</th>';
          t += '<th style="' + TH + '">Sites</th>';
          t += '<th style="' + TH + ';text-align:right">Last</th>';
          t += '</tr></thead><tbody>';
          incRows.forEach(function(row, i) {
            const name = row[0], d = row[1];
            const bg       = i % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)';
            const siteList = Array.from(d.sites).join(', ') || '—';
            t += '<tr style="background:' + bg + ';border-bottom:1px solid var(--border)">';
            t += '<td style="padding:9px 12px;font-weight:600;white-space:nowrap">' + esc(name) + '</td>';
            t += '<td style="padding:9px 12px;text-align:center"><span style="background:#fee2e2;color:#dc2626;padding:2px 9px;border-radius:999px;font-weight:700;font-size:11px">' + d.count + '</span></td>';
            t += '<td style="padding:9px 12px;text-align:center;color:var(--ink-3);font-size:11px">' + (d.high || '—') + '</td>';
            t += '<td style="padding:9px 12px;color:var(--ink-3);font-size:11px">' + esc(siteList) + '</td>';
            t += '<td style="padding:9px 12px;text-align:right;color:var(--ink-4);font-size:11px;white-space:nowrap">' + _sdFmtDate(d.lastDate) + '</td>';
            t += '</tr>';
          });
          t += '</tbody></table></div>';
          return t;
        })()
  );

  // ── Site coverage ──────────────────────────────────────────────
  const siteEntries = Object.entries(bySite).sort(function(a, b) {
    return (b[1].ps + b[1].tb) - (a[1].ps + a[1].tb);
  });
  const maxSiteTotal = siteEntries.reduce(function(m, e) { return Math.max(m, e[1].ps + e[1].tb + e[1].inc); }, 1);

  h += _sdCard('⬡ Site coverage (' + siteEntries.length + ' sites)',
    siteEntries.length === 0
      ? '<div style="padding:20px;text-align:center;color:var(--ink-3);font-size:12px">No data.</div>'
      : (function() {
          let t = '';
          siteEntries.forEach(function(entry) {
            const abbr  = entry[0], d = entry[1];
            const sObj  = typeof STATE !== 'undefined' ? (STATE.sites || []).find(function(s) { return s.abbr === abbr; }) : null;
            const label = sObj ? sObj.name : abbr;
            const total = d.ps + d.tb + d.inc;
            const fillW = Math.round(total / maxSiteTotal * 100);
            const psW   = total > 0 ? Math.round(d.ps / total * fillW) : 0;
            const tbW   = total > 0 ? Math.round(d.tb / total * fillW) : 0;
            const incW  = total > 0 ? (fillW - psW - tbW) : 0;
            t += '<div style="display:grid;grid-template-columns:120px 1fr auto;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border)">';
            t += '<div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(label) + '">' + esc(label) + '</div>';
            t += '<div style="background:var(--surface-2);border-radius:4px;overflow:hidden;height:8px">';
            t += '<div style="display:flex;height:100%">';
            if (psW) t += '<div style="width:' + psW + '%;background:var(--blue)"></div>';
            if (tbW) t += '<div style="width:' + tbW + '%;background:var(--green)"></div>';
            if (incW) t += '<div style="width:' + incW + '%;background:#dc2626"></div>';
            t += '</div></div>';
            t += '<div style="font-size:11px;white-space:nowrap"><span style="color:var(--blue);font-weight:600">' + d.ps + ' PS</span>'
              + ' <span style="color:var(--ink-4)">·</span>'
              + ' <span style="color:var(--green);font-weight:600">' + d.tb + ' TB</span>'
              + (d.inc ? ' <span style="color:var(--ink-4)">·</span> <span style="color:#dc2626;font-weight:600">' + d.inc + ' INC</span>' : '') + '</div>';
            t += '</div>';
          });
          return t;
        })()
  );

  // Legend
  h += '<div style="display:flex;gap:14px;font-size:11px;color:var(--ink-3);margin-bottom:4px">';
  h += '<span><span style="display:inline-block;width:10px;height:10px;background:var(--blue);border-radius:2px;vertical-align:middle;margin-right:4px"></span>Prestart (PS)</span>';
  h += '<span><span style="display:inline-block;width:10px;height:10px;background:var(--green);border-radius:2px;vertical-align:middle;margin-right:4px"></span>Toolbox talk (TB)</span>';
  h += '<span><span style="display:inline-block;width:10px;height:10px;background:#dc2626;border-radius:2px;vertical-align:middle;margin-right:4px"></span>Incident / near miss (INC)</span>';
  h += '</div>';

  el.innerHTML = h;
}
