// supabase-backup-worker — merged: daily backup + 15-min labour snapshot
//
// CRON TRIGGERS (add both in CF dashboard → Worker → Settings → Triggers):
//   */15 * * * *   → labour snapshot (writes labour-snapshot.html + .json to bucket root)
//   <your existing daily cron>  → full table backup (unchanged behaviour)
//
// ENV VARS — existing, no changes needed:
//   SUPABASE_URL              (var)
//   SUPABASE_SERVICE_ROLE_KEY (secret)
//   BACKUP_PREFIX             (var)
//   RETENTION_WEEKS           (var)
//   BACKUP_BUCKET             (R2 binding)
//
// NEW VAR TO ADD in CF dashboard → Settings → Variables:
//   ORG_ID = 1eb831f9-aeae-4e57-b49e-9681e8f51e15
//
// FETCH ROUTES (no auth required for snapshot):
//   GET /                     → serves labour-snapshot.html
//   GET /labour-snapshot.json → serves labour-snapshot.json
//   GET / + Bearer auth       → triggers manual backup (existing behaviour)

// ── Backup config (unchanged) ─────────────────────────────────────────────
const TABLES = [
  "organisations", "people", "schedule", "sites", "managers",
  "leave_requests", "timesheets", "job_numbers", "audit_log",
  "app_config", "rate_limits", "sks_quotes", "sks_quotes_config",
  "sks_quotes_customers", "sks_quotes_rates", "sks_quotes_materials",
  "sks_quotes_vocab",
];
const PAGE_SIZE = 1000;

// ── Snapshot config ───────────────────────────────────────────────────────
const SNAPSHOT_CRON   = "*/15 * * * *";
const SKS_LOGO_WHITE  = "https://pub-97a4f025d993484e91b8f15a8c73084d.r2.dev/SKS_Logo_White_Text_Clean.png";
const DAYS            = ["mon","tue","wed","thu","fri","sat","sun"];
const DAY_LABELS      = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const WEEKS_AHEAD     = 4;

const SECURITY_HEADERS = {
  "X-Content-Type-Options":    "nosniff",
  "X-Frame-Options":           "DENY",
  "Referrer-Policy":           "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

// ── Main export ───────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    if (event.cron === SNAPSHOT_CRON) {
      ctx.waitUntil(runSnapshot(env));
    } else {
      ctx.waitUntil(runBackup(env));
    }
  },

  async fetch(req, env, ctx) {
    const url  = new URL(req.url);
    const path = url.pathname;

    // Public snapshot endpoints — no auth needed
    if (path === "/" || path === "/labour-snapshot.html") {
      return serveFromR2(env, "labour-snapshot.html", "text/html; charset=utf-8");
    }
    if (path === "/labour-snapshot.json") {
      return serveFromR2(env, "labour-snapshot.json", "application/json");
    }

    // Manual backup trigger — requires Bearer <service-role-key>
    const auth     = req.headers.get("Authorization") ?? "";
    const expected = `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`;
    if (!env.SUPABASE_SERVICE_ROLE_KEY || auth !== expected) {
      return new Response("Not found", { status: 404 });
    }
    ctx.waitUntil(runBackup(env));
    return new Response("backup started\n", { status: 202 });
  },
};

// ── Serve R2 object with security headers ─────────────────────────────────
async function serveFromR2(env, key, contentType) {
  const obj = await env.BACKUP_BUCKET.get(key);
  if (!obj) {
    const body = contentType.includes("json")
      ? '{"error":"Snapshot not yet generated — cron has not run yet"}'
      : "<html><body style='font-family:Arial;padding:40px'><h2>Snapshot not yet generated</h2><p>The 15-minute cron has not run yet. Try again shortly.</p></body></html>";
    return new Response(body, {
      status: 404,
      headers: { "Content-Type": contentType, ...SECURITY_HEADERS },
    });
  }
  return new Response(obj.body, {
    headers: {
      "Content-Type":  contentType,
      "Cache-Control": "public, max-age=60",
      ...SECURITY_HEADERS,
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════
// SNAPSHOT — runs every 15 min
// ═════════════════════════════════════════════════════════════════════════
async function runSnapshot(env) {
  const start = Date.now();
  console.log("[snapshot] Starting run");
  try {
    const orgId = env.ORG_ID || "1eb831f9-aeae-4e57-b49e-9681e8f51e15";
    const weeks = getWeekKeys();  // ISO format for display/date math
    const weekIn = weeks.map(toDbWeek).join(",");  // DD.MM.YY for DB query

    const [people, schedule, sites, leaveRequests] = await Promise.all([
      sbGet(env, "people",
        `org_id=eq.${orgId}&archived=is.false&deleted_at=is.null` +
        `&select=id,name,group,archived&order=name.asc`),
      sbGet(env, "schedule",
        `org_id=eq.${orgId}&deleted_at=is.null` +
        `&week=in.(${weekIn})` +
        `&select=name,week,mon,tue,wed,thu,fri,sat,sun`),
      sbGet(env, "sites",
        `org_id=eq.${orgId}&deleted_at=is.null&select=id,name,abbr`),
      sbGet(env, "leave_requests",
        `org_id=eq.${orgId}&archived=is.false&status=eq.Approved` +
        `&select=requester_name,leave_type,date_start,date_end,individual_days`),
    ]);

    const generatedAt = new Date();
    const html = buildHTML({ people, schedule, sites, leaveRequests }, generatedAt);
    const json = JSON.stringify({
      generated_at: generatedAt.toISOString(),
      weeks_included: weeks,
      people_count: people.length,
      people, schedule, sites, leave_requests: leaveRequests,
    }, null, 2);

    await Promise.all([
      env.BACKUP_BUCKET.put("labour-snapshot.html", html, {
        httpMetadata: { contentType: "text/html; charset=utf-8", cacheControl: "public, max-age=60" },
      }),
      env.BACKUP_BUCKET.put("labour-snapshot.json", json, {
        httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=60" },
      }),
    ]);

    console.log(`[snapshot] Done in ${Date.now()-start}ms — ${people.length} people, ${schedule.length} schedule rows`);
  } catch (err) {
    console.error("[snapshot] FAILED:", err.message);
    throw err;
  }
}

async function sbGet(env, table, params) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: {
      apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept:        "application/json",
    },
  });
  if (!res.ok) throw new Error(`${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Date helpers ──────────────────────────────────────────────────────────
function getMondayOfWeek(date) {
  const d   = new Date(date);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

/** "2026-05-18" → "18.05.26" (matches how the SKS DB stores week keys) */
function toDbWeek(isoDate) {
  const [year, month, day] = isoDate.split("-");
  return `${day}.${month}.${year.slice(2)}`;
}

function getWeekKeys() {
  const weeks = new Set();
  for (let i = 0; i < WEEKS_AHEAD; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i * 7);
    weeks.add(getMondayOfWeek(d));
  }
  return [...weeks];
}

function fmtDate(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-AU",
    { day: "numeric", month: "short", timeZone: "UTC" });
}

function toAEST(date) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(date);
}

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

/** Expand a date range into individual ISO date strings */
function expandDateRange(start, end) {
  const days = [];
  try {
    const s = new Date(start + "T00:00:00Z");
    const e = new Date(end   + "T00:00:00Z");
    for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
  } catch (_) {}
  return days;
}

function shortLeave(t) {
  return { "Annual Leave":"AL","Sick Leave":"SL","Personal Leave":"PL",
           "RDO":"RDO","Public Holiday":"PH","Unpaid":"UNP","TAFE":"TAFE" }[t]
    ?? (t?.slice(0,4) || "LV");
}

// ── HTML builder ──────────────────────────────────────────────────────────
function buildHTML({ people, schedule, sites, leaveRequests }, generatedAt) {
  const weeks      = getWeekKeys();
  const currentWk  = getMondayOfWeek(new Date());
  const active     = people.filter(p => !p.archived && !p.deleted_at);

  const schedIdx = {};
  schedule.forEach(r => { schedIdx[`${r.name}||${r.week}`] = r; });

  const leaveSet = {};
  leaveRequests.forEach(l => {
    // Use individual_days if present, otherwise expand date_start → date_end range
    let days = Array.isArray(l.individual_days) && l.individual_days.length
      ? l.individual_days
      : expandDateRange(l.date_start, l.date_end);
    days.forEach(d => { leaveSet[`${l.requester_name}||${d}`] = l.leave_type; });
  });

  const GROUP_ORDER = ["Direct", "Labour Hire", "Apprentice"];
  const groups = {};
  active.forEach(p => {
    const g = p.group || "Other";
    if (!groups[g]) groups[g] = [];
    groups[g].push(p);
  });
  const allGroups = [
    ...GROUP_ORDER.filter(g => groups[g]?.length),
    ...Object.keys(groups).filter(g => !GROUP_ORDER.includes(g) && groups[g]?.length),
  ];
  allGroups.forEach(g => groups[g].sort((a,b) => a.name.localeCompare(b.name)));

  let weeksHTML = "";
  for (const week of weeks) {
    const isCurrent = week === currentWk;
    const weekDate  = new Date(week + "T00:00:00Z");
    const dateCols  = DAYS.map((_, i) => {
      const d = new Date(weekDate);
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });

    let groupsHTML = "";
    for (const gName of allGroups) {
      const gPeople = groups[gName] || [];
      let rows = "";
      for (const p of gPeople) {
        const entry = schedIdx[`${p.name}||${toDbWeek(week)}`] || {};
        let cells = "";
        for (let i = 0; i < 7; i++) {
          const val     = entry[DAYS[i]] || "";
          const isWE    = i >= 5;
          const onLeave = leaveSet[`${p.name}||${dateCols[i]}`];
          let cls       = isWE ? "cwe" : "cwd";
          let display   = esc(val);
          if (onLeave && !val) {
            display = `<span class="lv">${shortLeave(onLeave)}</span>`;
            cls    += " clv";
          } else if (!val) {
            cls += isWE ? "" : " cem";
          }
          cells += `<td class="${cls}">${display}</td>`;
        }
        rows += `<tr><td class="cnm">${esc(p.name)}</td>${cells}</tr>`;
      }
      groupsHTML += `
        <div class="ghdr">${esc(gName)} <span class="gc">${gPeople.length}</span></div>
        <div class="tw"><table>
          <thead><tr><th class="thn">Name</th>${DAYS.map((_,i)=>`<th class="thd">${DAY_LABELS[i]}<br><span class="ds">${fmtDate(dateCols[i])}</span></th>`).join("")}</tr></thead>
          <tbody>${rows}</tbody>
        </table></div>`;
    }

    weeksHTML += `
      <section class="wk${isCurrent?" wkc":""}">
        <div class="wh">${isCurrent?'<span class="cb">CURRENT WEEK</span> ':""} Week of ${fmtDate(week)}</div>
        ${groupsHTML}
      </section>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SKS Labour — Snapshot</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:14px;background:#f2f4f8;color:#1a1a2e}
.bnr{background:#1F335C;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:14px}
.bnr img{height:38px;flex-shrink:0}
.bt h1{font-size:17px;font-weight:700;line-height:1.2}
.bt p{font-size:12px;opacity:.75;margin-top:2px}
.tsb{background:#162844;color:#fff;padding:8px 20px;font-size:12px}
.tsb strong{color:#7FC8E8}.tsb a{color:#7FC8E8}
.wrn{background:#fff3cd;border-left:4px solid #ffc107;padding:9px 20px;font-size:13px;color:#664d03}
.cnt{max-width:1200px;margin:0 auto;padding:16px 20px}
.wk{margin-bottom:28px;border-radius:6px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.wh{background:#2c4270;color:#fff;padding:10px 16px;font-size:15px;font-weight:700;display:flex;align-items:center;gap:10px}
.wkc .wh{background:#1F335C}
.cb{background:#7C77B9;color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;text-transform:uppercase;letter-spacing:.6px}
.ghdr{background:#7C77B9;color:#fff;padding:6px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
.gc{opacity:.7;font-weight:normal;margin-left:4px}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:#fff}
th{background:#1F335C;color:#fff;padding:6px 8px;font-size:11px;text-align:center;white-space:nowrap;border-right:1px solid #2c4270}
.thn{text-align:left;min-width:120px}.ds{font-weight:400;opacity:.75;font-size:10px}
td{padding:5px 8px;border-bottom:1px solid #eaecef;font-size:12px;border-right:1px solid #f0f2f5}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f0f4ff}
.cnm{font-weight:500;white-space:nowrap;min-width:110px}
.cwd,.cwe{text-align:center}
.cwe{background:#f8f9fa;color:#aaa}
.cem{color:#ddd}.clv{background:#fef9ec}
.lv{background:#fff3cd;color:#856404;border:1px solid #ffc107;border-radius:3px;padding:1px 4px;font-size:10px;white-space:nowrap}
.ftr{text-align:center;padding:20px;color:#999;font-size:11px}
@media(max-width:640px){
  .bnr img{height:28px}.bt h1{font-size:14px}.cnt{padding:8px 10px}
  td,th{padding:4px 5px;font-size:11px}.thn,.cnm{min-width:85px}
}
@media print{
  .wrn{display:none}body{background:#fff}
  .bnr,.wh,.ghdr,th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .wk{break-inside:avoid;box-shadow:none;border:1px solid #ccc}
}
</style>
</head>
<body>
<div class="bnr">
  <img src="${SKS_LOGO_WHITE}" alt="SKS" onerror="this.style.display='none'">
  <div class="bt">
    <h1>SKS Labour — Live Snapshot</h1>
    <p>Read-only fallback &middot; Use when sks-nsw-labour.netlify.app is unavailable</p>
  </div>
</div>
<div class="tsb">
  Last updated: <strong>${toAEST(generatedAt)} AEST</strong>
  &nbsp;&middot;&nbsp; Refreshes every 15 min
  &nbsp;&middot;&nbsp; ${active.length} active staff
  &nbsp;&middot;&nbsp; <a href="/labour-snapshot.json">Raw JSON</a>
</div>
<div class="wrn">⚠️ <strong>Read-only.</strong> This snapshot cannot record changes. Enter timesheets and roster updates in the app once it's back online.</div>
<div class="cnt">${weeksHTML}</div>
<div class="ftr">sks-labour-snapshot &middot; ${generatedAt.toISOString()} UTC &middot; SKS Technologies NSW</div>
</body></html>`;
}

// ═════════════════════════════════════════════════════════════════════════
// BACKUP — unchanged from original (daily cron)
// ═════════════════════════════════════════════════════════════════════════
async function runBackup(env) {
  const startedAt = new Date();
  const date      = startedAt.toISOString().slice(0, 10);
  const folder    = `${env.BACKUP_PREFIX}/${date}`;
  console.log(`backup run start date=${date} tables=${TABLES.length}`);

  const tableResults = [];
  for (const table of TABLES) {
    const result = await backupTable(env, table, folder);
    tableResults.push(result);
    if (result.status === "ok") {
      console.log(`  ok   ${table} rows=${result.rows} bytes=${result.bytes}`);
    } else {
      console.error(`  fail ${table} ${result.error}`);
    }
  }

  const pruned   = await pruneOldBackups(env);
  const manifest = {
    date,
    started_at:      startedAt.toISOString(),
    finished_at:     new Date().toISOString(),
    source:          env.SUPABASE_URL,
    tables:          tableResults,
    pruned,
    retention_weeks: Number(env.RETENTION_WEEKS),
  };
  await env.BACKUP_BUCKET.put(
    `${folder}/_manifest.json`,
    JSON.stringify(manifest, null, 2),
    { httpMetadata: { contentType: "application/json" } }
  );

  const errors = tableResults.filter(r => r.status === "error").length;
  console.log(`backup run end errors=${errors} pruned=${pruned.length}`);
}

async function backupTable(env, table, folder) {
  try {
    const rows = [];
    let offset = 0;
    while (true) {
      const url = `${env.SUPABASE_URL}/rest/v1/${table}?select=*&limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await fetch(url, {
        headers: {
          apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Accept:        "application/json",
        },
      });
      if (!res.ok) {
        const body = await res.text();
        return { table, status: "error", error: `${res.status} ${res.statusText}: ${body.slice(0,500)}` };
      }
      const page = await res.json();
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    const json = JSON.stringify(rows);
    const key  = `${folder}/${table}.json`;
    await env.BACKUP_BUCKET.put(key, json, {
      httpMetadata: { contentType: "application/json" },
    });
    return { table, status: "ok", rows: rows.length, bytes: json.length, key };
  } catch (err) {
    return { table, status: "error", error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

async function pruneOldBackups(env) {
  const weeks     = Number(env.RETENTION_WEEKS);
  const cutoff    = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - weeks * 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const results   = [];
  try {
    const list = await env.BACKUP_BUCKET.list({
      prefix:    `${env.BACKUP_PREFIX}/`,
      delimiter: "/",
    });
    for (const folder of list.delimitedPrefixes ?? []) {
      const datePart = folder.slice(env.BACKUP_PREFIX.length + 1, env.BACKUP_PREFIX.length + 11);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) continue;
      if (datePart >= cutoffStr) continue;
      try {
        let deleted = 0;
        let cursor;
        do {
          const contents = await env.BACKUP_BUCKET.list({ prefix: folder, cursor });
          if (contents.objects.length === 0) break;
          await Promise.all(contents.objects.map(o => env.BACKUP_BUCKET.delete(o.key)));
          deleted += contents.objects.length;
          cursor = contents.truncated ? contents.cursor : undefined;
        } while (cursor);
        results.push({ prefix: folder, objects_deleted: deleted, status: "ok" });
        console.log(`pruned ${folder} (${deleted} objects)`);
      } catch (err) {
        results.push({ prefix: folder, objects_deleted: 0, status: "error",
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      }
    }
  } catch (err) {
    results.push({ prefix: `${env.BACKUP_PREFIX}/`, objects_deleted: 0, status: "error",
      error: err instanceof Error ? `prune-list-failed: ${err.message}` : String(err) });
  }
  return results;
}
