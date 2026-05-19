# supabase-backup-worker

Weekly off-platform snapshot of the SKS Field Supabase tenant to Cloudflare R2.

## What it does

- Cron: `0 10 * * 3` (UTC) — Wednesdays 20:00 AEST (winter) / 21:00 AEDT (summer).
  CF cron is UTC only, so the local clock-time drifts by an hour across DST.
- Source: Supabase project `nspbmirochztcjijmcrx` (SKS Field).
- Destination: R2 bucket `sks-assets`, layout `backups/YYYY-MM-DD/<table>.json` plus `_manifest.json`.
- Auth: service-role JWT, so PostgREST bypasses RLS (this is what fixes the old
  worker's silent 400s on `app_config` and `rate_limits`).
- Retention: prunes any `backups/YYYY-MM-DD/` folder older than `RETENTION_WEEKS`
  (default 12) at the end of each run. Prune failures are logged to the
  manifest but never abort the backup itself.

## Why this exists in the repo

Source of truth is `workers/supabase-backup/`. **Do not edit this worker via
the Cloudflare dashboard.** Edit here, test with `wrangler dev`, deploy with
`wrangler deploy`.

## Tables backed up

Defined in `src/index.ts` (`TABLES` constant). Adding a new table = add the
name to that array and redeploy.

`claude_context` was in the old worker's table list but doesn't exist in the
schema; it has been dropped.

## Setup (one-time)

```sh
cd workers/supabase-backup
npm install

# Authenticate wrangler to Royce's CF account (account_id is in wrangler.toml).
npx wrangler login

# Set the service-role secret. Get the value from Supabase dashboard →
# nspbmirochztcjijmcrx → Project Settings → API → service_role secret.
# This is the same secret the old dashboard worker uses; if it's already set
# on the deployed worker, wrangler will keep it on the next deploy.
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

## Local smoke test

```sh
# Terminal 1
npx wrangler dev --test-scheduled

# Terminal 2
curl "http://localhost:8787/__scheduled?cron=0+10+*+*+3"
```

The scheduled handler writes to the real R2 bucket even in dev mode unless you
pass `--local` (which uses the local R2 emulator). Use `--local` for the first
smoke test:

```sh
npx wrangler dev --test-scheduled --local
```

When the run is clean, the latest `backups/YYYY-MM-DD/_manifest.json` should
show every table with `"status": "ok"`.

## Deploy

```sh
npx wrangler deploy
```

After deploy:

1. CF dash → Workers & Pages → `supabase-backup-worker` → **Triggers** —
   confirm only `0 10 * * 3` exists. Delete any leftover `0 16 * * *` cron.
2. CF dash → **Logs** → trigger manually via the "Send" button or `wrangler
   triggers cron`. Watch for a clean run.
3. R2 → `sks-assets/backups/` — confirm a fresh `YYYY-MM-DD/` folder appears
   with `_manifest.json` showing zero errors.

## Environment variables

Non-secret (declared in `wrangler.toml [vars]`):

| Name | Value | Notes |
|---|---|---|
| `SUPABASE_URL` | `https://nspbmirochztcjijmcrx.supabase.co` | SKS project base URL |
| `BACKUP_PREFIX` | `backups` | R2 key prefix |
| `RETENTION_WEEKS` | `12` | Folder age in weeks before pruning |

Secrets (set via `wrangler secret put`):

| Name | Source |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dash → Project Settings → API → `service_role` |

## Manifest shape

```json
{
  "date": "2026-05-19",
  "started_at": "2026-05-19T10:00:00.123Z",
  "finished_at": "2026-05-19T10:00:42.456Z",
  "source": "https://nspbmirochztcjijmcrx.supabase.co",
  "retention_weeks": 12,
  "tables": [
    { "table": "people", "status": "ok", "rows": 142, "bytes": 38214, "key": "backups/2026-05-19/people.json" },
    { "table": "app_config", "status": "error", "error": "400 Bad Request: ..." }
  ],
  "pruned": [
    { "prefix": "backups/2026-02-12/", "objects_deleted": 18, "status": "ok" }
  ]
}
```

## Future work (not in this worker yet)

- Backing up the EQ tenant (`ktmjmdzqrogauaevbktn`). Same code, different
  `SUPABASE_URL` + key + prefix. Probably a sibling worker rather than
  multi-tenant logic in this one.
- Restore script. Per-table JSON dumps aren't trivially restorable because
  of FK ordering; needs a Node script that reads a manifest and bulk-inserts
  in a safe order.
- Off-CF copy (R2 is on the same account as the worker, so an account
  compromise loses both). Lower priority; weekly account-compromise drills
  aren't a realistic threat model right now.
