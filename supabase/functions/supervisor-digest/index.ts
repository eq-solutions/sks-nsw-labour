/*! Property of EQ — all rights reserved. Unauthorised use prohibited. */
// ─────────────────────────────────────────────────────────────
// Supabase Edge Function: supervisor-digest
// EQ Solves — Field  v3.4.62
// ─────────────────────────────────────────────────────────────
//
// Sends a Friday 12:00 AEST digest email to each opted-in supervisor.
//
// Section order (v3.4.62 — actionable-first):
//   1. Pending leave requests where approver_name matches this supervisor
//   2. Timesheet completion for LAST week (the completed week just gone)
//      — per-day breakdown ("Alex · Mon, Wed, Fri missing") + inline
//      mailto "Remind them" link beside each missing person row
//   3. Approved leave overlapping NEXT week (Mon → Sun)
//   4. People with no roster entry for NEXT week (unrostered, group summary)
//
// v3.4.62 fix: timesheet section was previously reporting THIS week
// (still-in-progress at Friday 12:00) so the percentage was always
// artificially low — Friday hours hadn't been logged yet. Switching
// to LAST week matches how timesheets are actually filled (after the
// work happens) and gives supervisors a clean chase list.
//
// Per-org config (app_config rows, key = 'digest_timesheet_groups'):
//   Comma-separated list of groups to scope the timesheet section to.
//   e.g. value = 'Apprentice,Supervisor' → only those two groups count.
//   Empty / missing → all rostered groups counted.
//
// Invocation:
//   - pg_cron: every Friday 02:00 UTC (= 12:00 AEST / 13:00 AEDT summer)
//     See migrations/2026-04-19_digest_cron_schedule.sql
//   - Manual: POST { dryRun?: boolean, orgSlug?: string }
// ─────────────────────────────────────────────────────────────

// deno-lint-ignore-file no-explicit-any
import { createClient, SupabaseClient } from "@supabase/supabase-js";

type Manager = { id: string; org_id: string; name: string; email: string | null; digest_opt_in: boolean; deleted_at: string | null; };
type Person = { id: string; org_id: string; name: string; email: string | null; group: string | null; deleted_at: string | null; };
type LeaveReq = { id: string; org_id: string; requester_name: string; approver_name: string; leave_type: string | null; date_start: string | null; date_end: string | null; status: string | null; note: string | null; archived: boolean | null; created_at: string | null; };
type ScheduleRow = { org_id: string; name: string; week: string; mon: string | null; tue: string | null; wed: string | null; thu: string | null; fri: string | null; sat: string | null; sun: string | null; };
type TimesheetRow = {
  org_id: string; name: string; week: string;
  mon: number | null; tue: number | null; wed: number | null; thu: number | null; fri: number | null; sat: number | null; sun: number | null;
  mon_hrs: number | null; tue_hrs: number | null; wed_hrs: number | null; thu_hrs: number | null; fri_hrs: number | null; sat_hrs: number | null; sun_hrs: number | null;
};

function pad2(n: number): string { return n < 10 ? "0" + n : String(n); }
function mondayKey(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = utc.getUTCDay();
  const delta = (dow + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - delta);
  return `${pad2(utc.getUTCDate())}.${pad2(utc.getUTCMonth() + 1)}.${String(utc.getUTCFullYear()).slice(-2)}`;
}
function mondayKeyPlusWeeks(d: Date, weeks: number): string {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  u.setUTCDate(u.getUTCDate() + 7 * weeks);
  return mondayKey(u);
}
function mondayDate(key: string): Date {
  const [dd, mm, yy] = key.split(".").map((s) => parseInt(s, 10));
  return new Date(Date.UTC(2000 + yy, mm - 1, dd));
}
function fmtISODate(d: Date): string { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function fmtPrettyDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00Z");
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const mons = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${mons[d.getUTCMonth()]}`;
}

const LEAVE_TERMS = new Set(["A/L","AL","LVE","LEAVE","U/L","UL","RDO","PH","SICK","JURY","OFF","DAY OFF","PENDING"]);
function isRosteredCell(v: string | null | undefined): boolean {
  if (!v) return false;
  const u = String(v).trim().toUpperCase();
  if (!u) return false;
  if (LEAVE_TERMS.has(u)) return false;
  if (u === "TAFE" || u === "TRAINING") return false;
  return true;
}
function sleep(ms: number): Promise<void> { return new Promise((res) => setTimeout(res, ms)); }
function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Magic-link signing (v3.4.63) ─────────────────────────────
// Mints a token verified by netlify/functions/approve-leave.js.
// EQ_SECRET_SALT must be the SAME value as the Netlify project's
// EQ_SECRET_SALT (set as a Supabase function secret too) — otherwise
// the signatures won't match and every click lands on "expired".
//
// Token format mirrors verify-pin's session token:
//   base64(JSON payload) + '.' + hex(HMAC-SHA256)
// `kind: 'leave-action'` makes the signing-key reuse explicit —
// the same key signs session tokens, but those have no `kind` and
// approve-leave.js refuses anything that isn't 'leave-action'.
const LEAVE_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function bytesToHex(buf: ArrayBuffer): string {
  const arr = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < arr.length; i++) hex += arr[i].toString(16).padStart(2, "0");
  return hex;
}
async function signLeaveActionToken(secret: string, leaveId: string, action: "approve" | "reject", approverEmail: string): Promise<string> {
  const payload = JSON.stringify({
    kind: "leave-action",
    leave_id: leaveId,
    action,
    approver_email: approverEmail,
    exp: Date.now() + LEAVE_ACTION_TTL_MS,
  });
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return utf8ToBase64(payload) + "." + bytesToHex(sigBuf);
}

async function sendEmail(opts: { to: string; subject: string; html: string }): Promise<{ ok: boolean; detail: string }> {
  const transport = (Deno.env.get("DIGEST_TRANSPORT") || "resend").toLowerCase();
  if (transport === "resend") {
    const key = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("DIGEST_FROM_EMAIL") || "EQ Field <noreply@eq.solutions>";
    if (!key) return { ok: false, detail: "RESEND_API_KEY not set" };
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [opts.to], subject: opts.subject, html: opts.html }),
    });
    return { ok: resp.ok, detail: (await resp.text()).slice(0, 500) };
  }
  if (transport === "netlify") {
    const url = Deno.env.get("NETLIFY_SEND_EMAIL_URL");
    const secret = Deno.env.get("EQ_DIGEST_SECRET");
    if (!url || !secret) return { ok: false, detail: "NETLIFY_SEND_EMAIL_URL or EQ_DIGEST_SECRET not set" };
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-eq-digest-secret": secret },
      body: JSON.stringify({ to: [opts.to], subject: opts.subject, html: opts.html }),
    });
    return { ok: resp.ok, detail: (await resp.text()).slice(0, 500) };
  }
  return { ok: false, detail: `unknown DIGEST_TRANSPORT: ${transport}` };
}

// v3.4.62 reorder: actionable first (approvals + chase last week's
// timesheets) then forward-looking (next week's leave + roster gaps).
// Per-day breakdown for missing list + inline mailto "Remind them".
function buildDigestHtml(params: {
  orgName: string;
  supervisorName: string;
  weekKeyNext: string;
  weekKeyPrev: string;
  leaveNextWeek: LeaveReq[];
  pendingForMe: LeaveReq[];
  // v3.4.63: per-pending-leave magic-link URLs keyed by leave id.
  // When provided, each row gets ✓ Approve / ✕ Reject buttons.
  pendingActions: Record<string, { approveUrl: string; rejectUrl: string }>;
  unrosteredSummary: { total: number; byGroup: Array<{ group: string; n: number }> };
  tsCompletion: {
    submitted: number; expected: number;
    missing: Array<{ name: string; days: number; dayLabels: string[]; email: string | null }>;
    scopeLabel: string | null;
  };
  appOrigin: string;
}): string {
  const { orgName, supervisorName, weekKeyNext, weekKeyPrev, leaveNextWeek, pendingForMe, pendingActions, unrosteredSummary, tsCompletion, appOrigin } = params;

  const nextMondayISO = fmtISODate(mondayDate(weekKeyNext));
  const nextSundayDate = new Date(mondayDate(weekKeyNext));
  nextSundayDate.setUTCDate(nextSundayDate.getUTCDate() + 6);
  const nextSundayISO = fmtISODate(nextSundayDate);

  const prevMondayISO = fmtISODate(mondayDate(weekKeyPrev));
  const prevSundayDate = new Date(mondayDate(weekKeyPrev));
  prevSundayDate.setUTCDate(prevSundayDate.getUTCDate() + 6);
  const prevSundayISO = fmtISODate(prevSundayDate);
  const prevPretty = `${fmtPrettyDate(prevMondayISO)} → ${fmtPrettyDate(prevSundayISO)}`;

  const leaveTableRows = leaveNextWeek.length
    ? leaveNextWeek.map((r) => `<tr><td style="padding:8px 10px;border-top:1px solid #E5E7EB">${escHtml(r.requester_name)}</td><td style="padding:8px 10px;border-top:1px solid #E5E7EB">${escHtml(r.leave_type || "—")}</td><td style="padding:8px 10px;border-top:1px solid #E5E7EB">${fmtPrettyDate(r.date_start)} → ${fmtPrettyDate(r.date_end)}</td><td style="padding:8px 10px;border-top:1px solid #E5E7EB;color:#6B7280">${escHtml(r.approver_name || "—")}</td></tr>`).join("")
    : `<tr><td colspan="4" style="padding:12px 10px;color:#6B7280;border-top:1px solid #E5E7EB;font-style:italic">Nobody approved off next week.</td></tr>`;

  // v3.4.63: per-row Approve/Reject magic-link buttons when pendingActions
  // is populated. Falls back to dash when token-mint failed (e.g. salt
  // missing) so the email still renders. Single colspan = 5 (one extra
  // column for buttons) when ANY row has actions; otherwise 4 (legacy).
  const hasActions = !!(pendingActions && Object.keys(pendingActions).length);
  const colspan = hasActions ? 5 : 4;
  const pendingRows = pendingForMe.length
    ? pendingForMe.map((r) => {
        const actions = pendingActions && pendingActions[r.id];
        const actionCell = hasActions
          ? `<td style="padding:8px 10px;border-top:1px solid #E5E7EB;white-space:nowrap">${actions
              ? `<a href="${escHtml(actions.approveUrl)}" style="display:inline-block;background:#16A34A;color:white;padding:5px 10px;border-radius:6px;text-decoration:none;font-size:11px;font-weight:600;margin-right:4px">✓ Approve</a><a href="${escHtml(actions.rejectUrl)}" style="display:inline-block;background:#DC2626;color:white;padding:5px 10px;border-radius:6px;text-decoration:none;font-size:11px;font-weight:600">✕ Reject</a>`
              : `<span style="color:#9CA3AF;font-size:11px">—</span>`
            }</td>`
          : "";
        return `<tr><td style="padding:8px 10px;border-top:1px solid #E5E7EB">${escHtml(r.requester_name)}</td><td style="padding:8px 10px;border-top:1px solid #E5E7EB">${escHtml(r.leave_type || "—")}</td><td style="padding:8px 10px;border-top:1px solid #E5E7EB">${fmtPrettyDate(r.date_start)} → ${fmtPrettyDate(r.date_end)}</td><td style="padding:8px 10px;border-top:1px solid #E5E7EB;color:#6B7280">${escHtml((r.note || "").slice(0, 80))}</td>${actionCell}</tr>`;
      }).join("")
    : `<tr><td colspan="${colspan}" style="padding:12px 10px;color:#6B7280;border-top:1px solid #E5E7EB;font-style:italic">No pending requests waiting on you.</td></tr>`;

  // v3.4.9.3-preserved: unrostered is a group summary (not a name list)
  // — keeps the digest scannable at SKS scale (50+ names is too much).
  const unrosteredHtml = unrosteredSummary.total === 0
    ? `<p style="margin:8px 0 0;color:#10B981;font-size:13px">Everyone is on the roster for next week.</p>`
    : `<p style="margin:8px 0 0;color:#374151;font-size:13px"><strong>${unrosteredSummary.total}</strong> not yet rostered — ${unrosteredSummary.byGroup.map((g) => `${g.n} ${escHtml(g.group)}`).join(", ")}.</p>`;

  const completionPct = tsCompletion.expected > 0 ? Math.round((tsCompletion.submitted / tsCompletion.expected) * 100) : null;
  const completionBar = completionPct === null ? "" : `<div style="margin-top:8px;background:#E5E7EB;border-radius:4px;height:8px;overflow:hidden"><div style="width:${completionPct}%;background:${completionPct >= 90 ? "#10B981" : completionPct >= 70 ? "#F59E0B" : "#EF4444"};height:8px"></div></div>`;

  // v3.4.62: per-day breakdown + inline mailto Remind-them link.
  const missingListHtml = tsCompletion.missing.length
    ? `<p style="margin:10px 0 0;font-size:12px;color:#6B7280">Still to submit:</p><ul style="margin:4px 0 0;padding-left:20px;color:#374151;font-size:13px">${tsCompletion.missing.map((m) => {
        const suffix = m.dayLabels.length
          ? ` <span style="color:#B45309;font-weight:600">· ${escHtml(m.dayLabels.join(", "))} missing</span>`
          : ` <span style="color:#B45309;font-weight:600">· ${m.days} day${m.days !== 1 ? "s" : ""} missing</span>`;
        const remindBtn = m.email
          ? ` <a href="mailto:${escHtml(m.email)}?subject=${encodeURIComponent("Timesheet reminder — week of " + prevPretty)}&body=${encodeURIComponent(
              `Hi ${m.name.split(" ")[0] || m.name},\n\nCould you complete your timesheet for the week of ${prevPretty}? ` +
              (m.dayLabels.length ? `Still missing: ${m.dayLabels.join(", ")}.\n\n` : "\n\n") +
              `Thanks.`
            )}" style="font-size:11px;color:#1F335C;text-decoration:underline;margin-left:6px">Remind them →</a>`
          : "";
        return `<li style="padding:3px 0">${escHtml(m.name)}${suffix}${remindBtn}</li>`;
      }).join("")}</ul>`
    : `<p style="margin:10px 0 0;font-size:13px;color:#059669;font-weight:600">🎉 Everyone is up to date for ${escHtml(prevPretty)}.</p>`;

  const scopeChip = tsCompletion.scopeLabel ? ` <span style="font-weight:400;color:#6B7280;font-size:12px">(${escHtml(tsCompletion.scopeLabel)})</span>` : "";

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#F9FAFB">
    <div style="background:#1F335C;padding:20px 24px;border-radius:12px 12px 0 0">
      <div style="color:white;font-weight:700;font-size:18px">Weekly Supervisor Digest</div>
      <div style="color:rgba(255,255,255,.7);font-size:13px;margin-top:2px">${escHtml(orgName)} · for ${escHtml(supervisorName)}</div>
      <div style="color:rgba(255,255,255,.55);font-size:12px;margin-top:6px">Looking back: ${fmtPrettyDate(prevMondayISO)} → ${fmtPrettyDate(prevSundayISO)} · Looking ahead: ${fmtPrettyDate(nextMondayISO)} → ${fmtPrettyDate(nextSundayISO)}</div>
    </div>

    <div style="background:white;padding:20px 24px;border:1px solid #E5E7EB;border-top:none">
      <h3 style="margin:0 0 6px;font-size:15px;color:#1F335C">1. Pending your approval <span style="color:#D97706">${pendingForMe.length ? `(${pendingForMe.length})` : ""}</span></h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151"><thead><tr style="text-align:left;color:#6B7280;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em"><th style="padding:6px 10px">Who</th><th style="padding:6px 10px">Type</th><th style="padding:6px 10px">Dates</th><th style="padding:6px 10px">Note</th>${hasActions ? `<th style="padding:6px 10px">Action</th>` : ""}</tr></thead><tbody>${pendingRows}</tbody></table>
      ${pendingForMe.length ? `<div style="margin-top:14px"><a href="${escHtml(appOrigin)}" style="display:inline-block;background:#1F335C;color:white;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">Review in App →</a></div>` : ""}
    </div>

    <div style="background:white;padding:20px 24px;border:1px solid #E5E7EB;border-top:none">
      <h3 style="margin:0 0 6px;font-size:15px;color:#1F335C">2. Timesheets — last week <span style="color:#6B7280;font-weight:400;font-size:12px">(${escHtml(prevPretty)})</span>${scopeChip}</h3>
      ${completionPct === null
        ? `<p style="margin:8px 0 0;color:#6B7280;font-size:13px;font-style:italic">No rostered days last week — nothing to chase.</p>`
        : `<div style="font-size:13px;color:#374151"><strong>${completionPct}%</strong> submitted <span style="color:#6B7280">(${tsCompletion.submitted} of ${tsCompletion.expected} rostered days)</span></div>${completionBar}${missingListHtml}`}
    </div>

    <div style="background:white;padding:20px 24px;border:1px solid #E5E7EB;border-top:none">
      <h3 style="margin:0 0 6px;font-size:15px;color:#1F335C">3. On leave next week</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151"><thead><tr style="text-align:left;color:#6B7280;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em"><th style="padding:6px 10px">Who</th><th style="padding:6px 10px">Type</th><th style="padding:6px 10px">Dates</th><th style="padding:6px 10px">Approver</th></tr></thead><tbody>${leaveTableRows}</tbody></table>
    </div>

    <div style="background:white;padding:20px 24px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px">
      <h3 style="margin:0 0 6px;font-size:15px;color:#1F335C">4. Unrostered next week <span style="color:${unrosteredSummary.total ? "#D97706" : "#10B981"}">${unrosteredSummary.total ? `(${unrosteredSummary.total})` : ""}</span></h3>
      ${unrosteredHtml}
    </div>

    <div style="padding:14px 4px 4px;font-size:11px;color:#9CA3AF;text-align:center">
      Sent every Friday at 12:00 AEST · <a href="${escHtml(appOrigin)}" style="color:#6B7280">${escHtml(appOrigin)}</a><br>Toggle off on the Supervision page to opt out.
    </div>
  </div>`;
}

async function runForOrg(sb: SupabaseClient, orgId: string, orgName: string, opts: { dryRun: boolean; appOrigin: string }) {
  const now = new Date();
  const weekKeyNext = mondayKeyPlusWeeks(now, 1);
  // v3.4.62: timesheets + scheduling for completion section use LAST week.
  const weekKeyPrev = mondayKeyPlusWeeks(now, -1);
  const nextMondayISO = fmtISODate(mondayDate(weekKeyNext));
  const nextSundayDate = new Date(mondayDate(weekKeyNext));
  nextSundayDate.setUTCDate(nextSundayDate.getUTCDate() + 6);
  const nextSundayISO = fmtISODate(nextSundayDate);

  const [mgrsRes, peopleRes, leaveOverlapRes, pendingRes, schedPrevRes, schedNextRes, tsPrevRes, cfgRes] = await Promise.all([
    sb.from("managers").select("id,org_id,name,email,digest_opt_in,deleted_at").eq("org_id", orgId).eq("digest_opt_in", true).is("deleted_at", null).not("email", "is", null),
    sb.from("people").select("id,org_id,name,email,group,deleted_at").eq("org_id", orgId).is("deleted_at", null),
    sb.from("leave_requests").select("id,org_id,requester_name,approver_name,leave_type,date_start,date_end,status,note,archived,created_at").eq("org_id", orgId).eq("status", "Approved").or("archived.is.null,archived.eq.false").lte("date_start", nextSundayISO).gte("date_end", nextMondayISO),
    sb.from("leave_requests").select("id,org_id,requester_name,approver_name,leave_type,date_start,date_end,status,note,archived,created_at").eq("org_id", orgId).eq("status", "Pending").or("archived.is.null,archived.eq.false"),
    // v3.4.62: LAST week's schedule (was THIS week's).
    sb.from("schedule").select("org_id,name,week,mon,tue,wed,thu,fri,sat,sun").eq("org_id", orgId).eq("week", weekKeyPrev),
    sb.from("schedule").select("org_id,name,week,mon,tue,wed,thu,fri,sat,sun").eq("org_id", orgId).eq("week", weekKeyNext),
    // v3.4.62: LAST week's timesheets (was THIS week's).
    sb.from("timesheets").select("org_id,name,week,mon,tue,wed,thu,fri,sat,sun,mon_hrs,tue_hrs,wed_hrs,thu_hrs,fri_hrs,sat_hrs,sun_hrs").eq("org_id", orgId).eq("week", weekKeyPrev),
    sb.from("app_config").select("key,value,org_id").eq("org_id", orgId).eq("key", "digest_timesheet_groups").maybeSingle(),
  ]);

  const errs = [mgrsRes, peopleRes, leaveOverlapRes, pendingRes, schedPrevRes, schedNextRes, tsPrevRes].filter((r) => r.error).map((r) => r.error!.message);
  if (errs.length) return { orgId, sent: 0, errors: errs };

  const managers = (mgrsRes.data || []) as Manager[];
  const people = (peopleRes.data || []) as Person[];
  const leaveOverlap = (leaveOverlapRes.data || []) as LeaveReq[];
  const pendingAll = (pendingRes.data || []) as LeaveReq[];
  const schedPrev = (schedPrevRes.data || []) as ScheduleRow[];
  const schedNext = (schedNextRes.data || []) as ScheduleRow[];
  const tsPrev = (tsPrevRes.data || []) as TimesheetRow[];

  const cfgVal = (cfgRes && (cfgRes as any).data && (cfgRes as any).data.value) ? String((cfgRes as any).data.value) : "";
  const tsGroupSet = new Set(cfgVal.split(",").map((s) => s.trim()).filter(Boolean));
  const tsScopeLabel = tsGroupSet.size > 0 ? Array.from(tsGroupSet).join(" + ") + " only" : null;

  const personGroupByName: Record<string, string | null> = {};
  const emailByName: Record<string, string | null> = {};
  for (const p of people) { personGroupByName[p.name] = p.group ?? null; emailByName[p.name] = p.email; }

  const rosteredNames = new Set<string>();
  for (const r of schedNext) {
    if (isRosteredCell(r.mon) || isRosteredCell(r.tue) || isRosteredCell(r.wed) || isRosteredCell(r.thu) || isRosteredCell(r.fri) || isRosteredCell(r.sat) || isRosteredCell(r.sun)) rosteredNames.add(r.name);
  }
  const unrosteredCounts = new Map<string, number>();
  let unrosteredTotal = 0;
  for (const p of people) {
    if (rosteredNames.has(p.name)) continue;
    unrosteredTotal += 1;
    const g = (p.group && p.group.trim()) ? p.group.trim() : "Other";
    unrosteredCounts.set(g, (unrosteredCounts.get(g) || 0) + 1);
  }
  const unrosteredByGroup = Array.from(unrosteredCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([group, n]) => ({ group, n }));
  const unrosteredSummary = { total: unrosteredTotal, byGroup: unrosteredByGroup };

  // v3.4.62: per-day labels per person.
  const dayKeys: Array<"mon"|"tue"|"wed"|"thu"|"fri"|"sat"|"sun"> = ["mon","tue","wed","thu","fri","sat","sun"];
  const dayLabels: Record<string, string> = { mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat", sun:"Sun" };
  const tsByName: Record<string, TimesheetRow> = {};
  for (const t of tsPrev) tsByName[t.name] = t;
  let expected = 0;
  let submitted = 0;
  const missingDaysByName = new Map<string, string[]>();
  for (const r of schedPrev) {
    if (tsGroupSet.size > 0) {
      const grp = personGroupByName[r.name];
      if (!grp || !tsGroupSet.has(grp)) continue;
    }
    for (const dk of dayKeys) {
      if (isRosteredCell(r[dk] as string | null)) {
        expected += 1;
        const ts = tsByName[r.name];
        // v3.4.9.3-preserved: prefer the _hrs column, fall back to legacy.
        const hrsNew = ts ? (ts[(dk + "_hrs") as keyof TimesheetRow] as number | null) : null;
        const hrsLegacy = ts ? (ts[dk] as number | null) : null;
        const hrs = (hrsNew && hrsNew > 0) ? hrsNew : hrsLegacy;
        if (hrs && hrs > 0) {
          submitted += 1;
        } else {
          const list = missingDaysByName.get(r.name) || [];
          list.push(dayLabels[dk]);
          missingDaysByName.set(r.name, list);
        }
      }
    }
  }
  const missing = Array.from(missingDaysByName.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, missingDayLabels]) => ({
      name,
      days: missingDayLabels.length,
      dayLabels: missingDayLabels,
      email: emailByName[name] || null,
    }));

  // v3.4.63: optional magic-link signing — populated when EQ_SECRET_SALT
  // is set on the function. Tokens are minted per-supervisor per-leave so
  // each link is bound to the right approver email + leave id.
  const secret = Deno.env.get("EQ_SECRET_SALT") || "";

  let sent = 0;
  const errors: string[] = [];
  const sendIntervalMs = Math.max(0, parseInt(Deno.env.get("DIGEST_SEND_INTERVAL_MS") || "600", 10));
  let firstLiveSend = true;
  for (const mgr of managers) {
    if (!mgr.email) continue;
    const pendingForMe = pendingAll.filter((r) => r.approver_name === mgr.name).sort((a, b) => (a.date_start || "").localeCompare(b.date_start || ""));

    // v3.4.63: mint a pair of magic-link URLs per pending request for this
    // approver. Empty object when secret isn't set, which disables the
    // Action column entirely (graceful degrade to v3.4.62 behaviour).
    const pendingActions: Record<string, { approveUrl: string; rejectUrl: string }> = {};
    if (secret && pendingForMe.length) {
      for (const r of pendingForMe) {
        if (!r.id) continue;
        try {
          const approveTok = await signLeaveActionToken(secret, r.id, "approve", String(mgr.email).toLowerCase());
          const rejectTok  = await signLeaveActionToken(secret, r.id, "reject",  String(mgr.email).toLowerCase());
          pendingActions[r.id] = {
            approveUrl: `${opts.appOrigin}/.netlify/functions/approve-leave?t=${encodeURIComponent(approveTok)}`,
            rejectUrl:  `${opts.appOrigin}/.netlify/functions/approve-leave?t=${encodeURIComponent(rejectTok)}`,
          };
        } catch (e) {
          console.warn("supervisor-digest: token-mint failed for leave", r.id, e instanceof Error ? e.message : e);
        }
      }
    }

    const html = buildDigestHtml({
      orgName,
      supervisorName: mgr.name,
      weekKeyNext,
      weekKeyPrev,
      leaveNextWeek: leaveOverlap.slice().sort((a, b) => (a.date_start || "").localeCompare(b.date_start || "")),
      pendingForMe,
      pendingActions,
      unrosteredSummary,
      tsCompletion: { submitted, expected, missing, scopeLabel: tsScopeLabel },
      appOrigin: opts.appOrigin,
    });

    // v3.4.62: subject prioritises retrospective chase items.
    const prevMondayISO = fmtISODate(mondayDate(weekKeyPrev));
    const prevPrettyMon = fmtPrettyDate(prevMondayISO);
    const missingCount = missing.length;
    const subject = missingCount > 0
      ? `🕐 ${missingCount} timesheet${missingCount !== 1 ? "s" : ""} to chase · week of ${prevPrettyMon}`
      : pendingForMe.length
        ? `Weekly digest · ${pendingForMe.length} pending for you · ${fmtPrettyDate(nextMondayISO)}`
        : `Weekly digest · ✅ all clear · ${fmtPrettyDate(nextMondayISO)}`;

    if (opts.dryRun) { sent += 1; continue; }
    if (!firstLiveSend && sendIntervalMs > 0) await sleep(sendIntervalMs);
    firstLiveSend = false;
    const res = await sendEmail({ to: mgr.email, subject, html });
    if (res.ok) sent += 1;
    else errors.push(`${mgr.name} <${mgr.email}>: ${res.detail}`);
  }

  return { orgId, sent, eligibleManagers: managers.length, errors, dryRun: opts.dryRun, tsScope: tsScopeLabel || "all groups", tsExpected: expected, tsSubmitted: submitted, unrosteredTotal, unrosteredByGroup };
}

Deno.serve(async (req) => {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!SUPABASE_URL || !SERVICE_KEY) return new Response(JSON.stringify({ ok: false, error: "missing supabase env" }), { status: 500 });
    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    let dryRun = false;
    let orgSlug: string | null = null;
    let appOrigin = Deno.env.get("APP_ORIGIN") || "https://eq-solves-field.netlify.app";
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body && typeof body === "object") {
          dryRun = !!(body.dryRun || body.dry_run);
          if (typeof body.orgSlug === "string") orgSlug = body.orgSlug;
          if (typeof body.appOrigin === "string") appOrigin = body.appOrigin;
        }
      } catch { /* no body fine */ }
    }

    const orgsQ = sb.from("organisations").select("id,slug,name").eq("active", true);
    if (orgSlug) orgsQ.eq("slug", orgSlug);
    const { data: orgs, error: orgsErr } = await orgsQ;
    if (orgsErr) return new Response(JSON.stringify({ ok: false, error: orgsErr.message }), { status: 500 });

    const results = [];
    for (const org of orgs || []) {
      try {
        const r = await runForOrg(sb, org.id, org.name || org.slug, { dryRun, appOrigin });
        results.push({ slug: org.slug, ...r });
      } catch (e) {
        const msg = (e instanceof Error) ? e.message : String(e);
        results.push({ slug: org.slug, error: msg });
      }
    }

    return new Response(JSON.stringify({ ok: true, dryRun, results }, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    const msg = (e instanceof Error) ? e.message : String(e);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 });
  }
});
