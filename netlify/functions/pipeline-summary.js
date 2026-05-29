// GET /.netlify/functions/pipeline-summary
//
// Server-to-server endpoint consumed by EQ Shell's ai-briefing function.
// Returns a structured summary of the SKS pipeline + resource state for
// use in the AI morning briefing.
//
// Auth: Authorization: Bearer <PIPELINE_API_KEY>
// No CORS — not called from a browser.
//
// Env vars:
//   PIPELINE_API_KEY  — shared secret with eq-shell
//   AUDIT_SB_URL      — Supabase REST URL
//   AUDIT_SB_KEY      — Supabase anon key
//   SKS_ORG_ID        — org_id filter (optional, single-tenant safety net)

const SB_URL          = process.env.AUDIT_SB_URL;
const SB_KEY          = process.env.AUDIT_SB_KEY;
const PIPELINE_API_KEY = process.env.PIPELINE_API_KEY;
const ORG_ID          = process.env.SKS_ORG_ID;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

async function sbGet(path, params) {
  const url = new URL(`${SB_URL}/rest/v1/${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status} on ${path}: ${text}`);
  }
  return res.json();
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  // Auth
  if (!PIPELINE_API_KEY) {
    console.error('[pipeline-summary] PIPELINE_API_KEY not set');
    return json(500, { ok: false, error: 'not_configured' });
  }
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!provided || provided !== PIPELINE_API_KEY) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  if (!SB_URL || !SB_KEY) {
    console.error('[pipeline-summary] Supabase env vars not set');
    return json(500, { ok: false, error: 'db_not_configured' });
  }

  try {
    const orgFilter = ORG_ID ? { 'org_id': `eq.${ORG_ID}` } : {};

    // ── Parallel queries ─────────────────────────────────────
    const [activeTenders, confirmedRaw, peopleRaw] = await Promise.all([

      // 1. All above-threshold, non-archived tenders in active stages
      sbGet('tenders', {
        select: 'stage,quote_value,job_name,client,due_date,is_high_confidence,probability_pct,probability_label',
        'stage': 'in.(watch,likely,won,confirmed)',
        'below_threshold': 'eq.false',
        'archived_at': 'is.null',
        ...orgFilter,
      }),

      // 2. Won/confirmed tenders + enrichment for resource planning
      sbGet('tenders', {
        select: 'job_name,client,quote_value,tender_enrichment(peak_workers,start_date_estimated,duration_weeks)',
        'stage': 'in.(won,confirmed)',
        'below_threshold': 'eq.false',
        'archived_at': 'is.null',
        ...orgFilter,
      }),

      // 3. Active headcount
      sbGet('people', {
        select: 'id',
        'archived': 'eq.false',
        ...orgFilter,
      }),

    ]);

    // ── Aggregate by stage ───────────────────────────────────
    const by_stage = {};
    for (const t of activeTenders) {
      if (!by_stage[t.stage]) by_stage[t.stage] = { count: 0, value_cents: 0 };
      by_stage[t.stage].count++;
      by_stage[t.stage].value_cents += Math.round((t.quote_value ?? 0) * 100);
    }

    const total_value_cents = activeTenders.reduce(
      (sum, t) => sum + Math.round((t.quote_value ?? 0) * 100), 0
    );

    // ── Verbal agreement tenders ─────────────────────────────
    // likely + probability >= 90% (is_high_confidence trigger)
    const verbal_agreement = activeTenders
      .filter(t => t.stage === 'likely' && t.is_high_confidence)
      .map(t => ({
        job_name:          t.job_name,
        client:            t.client ?? null,
        value_cents:       Math.round((t.quote_value ?? 0) * 100),
        due_date:          t.due_date ?? null,
        probability_label: t.probability_label ?? null,
      }));

    // ── Confirmed jobs for resource planning ─────────────────
    const confirmed_jobs = confirmedRaw.map(t => ({
      job_name:       t.job_name,
      client:         t.client ?? null,
      value_cents:    Math.round((t.quote_value ?? 0) * 100),
      peak_workers:   t.tender_enrichment?.peak_workers ?? null,
      start_date:     t.tender_enrichment?.start_date_estimated ?? null,
      duration_weeks: t.tender_enrichment?.duration_weeks ?? null,
    }));

    // ── Resource capacity ────────────────────────────────────
    const headcount   = peopleRaw.length;
    const peak_demand = confirmed_jobs
      .filter(j => j.peak_workers != null)
      .reduce((sum, j) => sum + (j.peak_workers ?? 0), 0);
    const bench = headcount > 0 && peak_demand > 0 ? headcount - peak_demand : null;

    // ── Recent pipeline events (last 48h) ─────────────────────
    // Non-fatal: pipeline_events table may not exist until migration is applied.
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let recent_events = [];
    try {
      recent_events = await sbGet('pipeline_events', {
        select: 'event,payload,occurred_at',
        'occurred_at': `gte.${cutoff}`,
        'order': 'occurred_at.desc',
        'limit': '20',
        ...orgFilter,
      });
    } catch {
      // Migration pending — skip silently
    }

    return json(200, {
      ok: true,
      pipeline: {
        total_value_cents,
        by_stage,
        verbal_agreement,
        confirmed_jobs,
        headcount,
        peak_demand,
        bench,
        recent_events,
      },
      fetched_at: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[pipeline-summary] error:', e.message);
    return json(500, { ok: false, error: 'internal_error', detail: e.message });
  }
};
