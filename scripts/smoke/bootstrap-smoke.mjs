#!/usr/bin/env node
// Post-deploy bootstrap smoke test for SKS Field.
//
// This repo had NO CI when the v3.10.90-92 outage shipped: a silent `order=id`
// 400 on two id-less tables froze the app on cached data for ~2 days, and
// nothing caught it. This script hits every table `loadFromSupabase()` reads,
// the way the app reads it, and fails (exit 1) on any non-2xx.
//
// Anon key + org id are public (the anon key is already embedded in
// scripts/app-state.js; the org id is resolved the same way the app does), so
// no secrets are needed. Run locally: `node scripts/smoke/bootstrap-smoke.mjs`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appState = readFileSync(join(here, '..', 'app-state.js'), 'utf8');
const m = appState.match(/sks:\s*\{\s*url:\s*'([^']+)',\s*key:\s*'([^']+)'/);
if (!m) { console.error('could not read the sks url/key out of scripts/app-state.js'); process.exit(2); }
const SB_URL = m[1], ANON = m[2];
const H = { apikey: ANON, Authorization: 'Bearer ' + ANON };

async function main() {
  // Resolve the org id the same way the app's own bootstrap does.
  const orgR = await fetch(SB_URL + '/rest/v1/organisations?slug=eq.sks&select=id', { headers: H });
  if (!orgR.ok) { console.error('FAIL organisations', orgR.status); process.exit(1); }
  const ORG = (await orgR.json())[0].id;
  const org = '&org_id=eq.' + ORG;

  // Queries mirror what loadFromSupabase() and its sibling loaders send today.
  const CHECKS = [
    ['people',          'people?select=id&order=name&limit=1'],
    ['sites',           'sites?select=id&order=name&limit=1'],
    ['managers',        'managers?select=id&order=name&limit=1'],
    ['teams',           'teams?select=id&order=name&limit=1'],
    ['schedule',        'schedule?select=id&order=id&limit=1'],
    ['timesheets',      'timesheets?select=id&order=id&limit=1'],
    ['team_members',    'team_members?select=team_id&order=team_id,person_id&limit=1'],
    ['timesheet_locks', 'timesheet_locks?select=week_key&order=week_key&limit=1'],
    ['leave_requests',  'leave_requests?select=id&order=created_at.desc&limit=1'],
  ];

  let failed = 0;
  for (const [name, q] of CHECKS) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/' + q + org, { headers: H });
      if (!r.ok) { failed++; console.error('FAIL ', name, r.status, (await r.text()).slice(0, 120)); }
      else console.log('ok   ', name, r.status);
    } catch (e) { failed++; console.error('FAIL ', name, 'network', e.message); }
  }

  // Invariant guard: team_members / timesheet_locks have NO id column. If the
  // fail-loud sbFetchAll is ever reverted to the old `order=id` default, THAT is
  // the regression — assert order=id still 400s on them, so it's caught here
  // rather than as a silent outage in prod.
  for (const name of ['team_members', 'timesheet_locks']) {
    const r = await fetch(SB_URL + '/rest/v1/' + name + '?select=*&order=id&limit=1' + org, { headers: H }).catch(() => null);
    if (r && r.status === 400) console.log('ok    guard', name, 'order=id -> 400 (still id-less, as expected)');
    else { failed++; console.error('FAIL  guard', name, 'expected 400 on order=id, got', r && r.status); }
  }

  if (failed) { console.error('\nSMOKE FAILED - ' + failed + ' check(s)'); process.exit(1); }
  console.log('\nSMOKE OK - all bootstrap reads healthy');
}

main().catch(e => { console.error('SMOKE ERROR', e); process.exit(1); });
