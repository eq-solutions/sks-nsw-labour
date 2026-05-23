# SKS NSW Labour — Deploy & Operations

> **Repo:** `github.com/eq-solutions/sks-nsw-labour`
> **Live site:** https://sks-nsw-labour.netlify.app
> **Local path:** `C:\Projects\sks-nsw-labour`
> **Current version:** see `scripts/app-state.js` → `APP_VERSION`

EQ Solves Field codebase. EQ still owns the code; this repo is the stable deploy lane for SKS, forked from `eq-solves-field` so the live SKS app isn't churned by active EQ Field development. **The two repos are operationally independent** — separate Netlify sites, separate branches, no cross-deploy.

---

## Quick deploy

Standard flow: PR → main → Netlify.

```
# from a feature/fix branch
git push -u origin claude/your-branch-name
gh pr create --base main --head claude/your-branch-name --title "vX.Y.Z — short description"
# review the deploy preview at deploy-preview-N--sks-nsw-labour.netlify.app
gh pr merge <PR#> --squash
```

Netlify auto-deploys `main` to `sks-nsw-labour.netlify.app` in ~90 seconds after the merge. SW cache key in `sw.js` (`eq-field-vX.Y.Z`) must change for each release or the old code stays cached on phones.

> There is **no `demo` branch** in this repo. There is **no shared deploy** with `eq-solves-field`.

### Per-release version bumps (4 files)

Every release must bump these together — the SW cache key is what forces phones to fetch fresh code:

| File | Field |
|------|-------|
| `scripts/app-state.js` | `APP_VERSION = 'X.Y.Z'` |
| `sw.js` | `CACHE = 'eq-field-vX.Y.Z'` + header comment |
| `index.html` | header comment block (`CHANGES IN vX.Y.Z`) |
| `CHANGELOG.md` | new entry at top |

If icons change, also bump the favicon cache-buster (`var v` in the inline script near line 23 of `index.html`).

---

## Netlify environment variables (required)

Set in **Netlify → Site Settings → Environment Variables**. Functions fail explicitly on startup if any are missing.

| Variable | Used by | Purpose |
|----------|---------|---------|
| `EQ_SECRET_SALT` | verify-pin, eq-agent, send-email | HMAC-SHA256 signing key for session tokens |
| `AUDIT_SB_URL` | verify-pin, eq-agent | Supabase REST URL for audit log writes |
| `AUDIT_SB_KEY` | verify-pin, eq-agent | Supabase publishable key for audit logging |
| `RESEND_API_KEY` | send-email | Resend email API key |
| `ANTHROPIC_API_KEY` | eq-agent | Anthropic API key for EQ Agent chat |
| `EMAIL_FROM` *(optional)* | send-email | Custom `From:` address; defaults to `EQ Field <noreply@eq.solutions>` |

No secrets are hardcoded. Rotating `EQ_SECRET_SALT` invalidates all session tokens — every user must re-login. CORS origin whitelist in each function permits `sks-nsw-labour.netlify.app`, `localhost` (dev), and Netlify deploy-preview subdomains.

---

## Netlify Functions

| Function | Auth | Purpose |
|----------|------|---------|
| `verify-pin.js` | PIN + HMAC-SHA256 | PIN validation, session token mint, remember-me |
| `eq-agent.js` | `x-eq-token` header | Anthropic API proxy for EQ Agent chat |
| `send-email.js` | `x-eq-token` header | Leave-request + supervisor-digest emails (Resend) |
| `approve-leave.js` | signed-link token | Approve/reject endpoint for emailed leave requests |

---

## Supabase edge functions

Deployed via the Supabase MCP / dashboard, not Netlify:

| Function | Purpose | README |
|----------|---------|--------|
| `supervisor-digest` | Friday 12:00 AEST email roundup of pending timesheets / leave | `supabase/functions/supervisor-digest/README.md` |
| `tafe-weekly-fill` | Auto-fills TAFE days on the roster for apprentices | `supabase/functions/tafe-weekly-fill/README.md` |
| `ts-reminder` | Per-staff timesheet reminder emails (12 h cooldown) | inline in `scripts/timesheets.js` |

---

## Security headers (`netlify.toml`)

| Header | Value |
|--------|-------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(self), payment=()` |
| `Content-Security-Policy` | self + Supabase + Google Fonts + R2 bucket |

`index.html`, `sw.js`, and `/scripts/*` are served `Cache-Control: no-cache, no-store, must-revalidate` so version bumps land immediately at the CDN. Service-worker cache key is the separate gate for the phone's local cache.

---

## Scripts folder

```
scripts/
├── app-state.js      ← Global state, tenant config, seed data, APP_VERSION
├── utils.js          ← Helpers: esc, toast, modal, CSV
├── supabase.js       ← sbFetch, write queue, upsert helpers
├── roster.js         ← Roster grid render + cell editing, schedule index
├── people.js         ← People CRUD + contacts
├── sites.js          ← Sites CRUD + grid
├── managers.js       ← Supervision CRUD
├── dashboard.js      ← Dashboard render
├── batch.js          ← Batch fill, copy last week
├── leave.js          ← Leave requests + email notifications
├── timesheets.js     ← Timesheet render (desktop table + phone card-stack),
│                       quick-fill, Fill Week safety model
├── jobnumbers.js     ← Job numbers CRUD + CSV
├── trial-dashboard.js← Trial dashboard view
├── import-export.js  ← Backup/restore, CSV import/export
├── calendar.js       ← Monthly calendar view
├── audit.js          ← Audit log write + modal + export + revert
├── realtime.js       ← Supabase Realtime subscriptions
└── auth.js           ← Gate, PIN check, supervisor auth, session token
```

---

## Smoke test (post-deploy)

| Test | Expected |
|------|----------|
| Sidebar version badge | Matches `APP_VERSION` from the just-shipped commit |
| Gate loads | Name picker + PIN field visible |
| Staff login (PIN: `2026`) | My Schedule view |
| Supervisor login (PIN: `SKSNSW`) | Dashboard, lock toggle shows unlocked |
| Weekly Roster | Grid renders with sticky name column; horizontal scroll on phone |
| Timesheets (desktop) | Wide table with filter chips, lock banner, repeat/split chips |
| Timesheets (phone, ≤768 px) | Card-stack — one card per person, default-collapsed |
| Timesheets phone — Fill Week | Banner appears after Mon is filled; two-tap arms; second tap fills; undo toast for 5 s |
| Leave → New Request | Modal opens, submit sends email |
| EQ Agent | Chat works, responses appear |
| Audit Log | Entries load from Supabase; per-row revert works |
| CORS check | DevTools network tab shows correct `Access-Control-Allow-Origin` |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Phone still shows old version after merge | Hard-refresh (Ctrl/Cmd-Shift-R). SW cache key must have bumped — check `sw.js` `CACHE` const matches `APP_VERSION`. |
| "Server misconfigured — missing EQ_SECRET_SALT" | Set the env var in Netlify and redeploy. |
| "Not authenticated — please log in again" | Session expired or token invalid — re-login. |
| Mobile cell edit doesn't save (no toast, no audit entry) | Check that `onTsCellChange` finds its peer inputs — `closest('tr, .ts-mday')` must match the current DOM shape. See `feedback-mobile-render-shared-handlers` in memory. |
| Hours chip popover dead on iOS | `ontouchstart preventDefault` suppresses synthesized click. Use `onpointerdown`. See `feedback-ios-touch-events` in memory. |
| 401 on send-email | Ensure `leave.js` passes `x-eq-token` header. |
| CORS error in console | Origin not in whitelist — check function `ALLOWED_ORIGINS` array. |
| Blank page | Syntax error — run `node --check scripts/X.js` locally before pushing. |

---

## Security documentation

See `EQ-Field-Security-Architecture.html` for the full security architecture document, suitable for SKS Technologies senior management.
