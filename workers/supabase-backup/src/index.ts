// Weekly off-platform snapshot of the SKS Supabase tenant to R2.
//
// Layout: <BACKUP_PREFIX>/YYYY-MM-DD/{<table>.json, _manifest.json}
// Retention: folders older than RETENTION_WEEKS are pruned at end of run.

export interface Env {
  BACKUP_BUCKET: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  BACKUP_PREFIX: string;
  RETENTION_WEEKS: string;
}

// Tables to back up. claude_context (in the old worker) is omitted — it
// doesn't exist in the schema. app_config and rate_limits are included;
// service-role auth bypasses the RLS that made them 400 previously.
const TABLES = [
  "organisations",
  "people",
  "schedule",
  "sites",
  "managers",
  "leave_requests",
  "timesheets",
  "job_numbers",
  "audit_log",
  "app_config",
  "rate_limits",
  "sks_quotes",
  "sks_quotes_config",
  "sks_quotes_customers",
  "sks_quotes_rates",
  "sks_quotes_materials",
  "sks_quotes_vocab",
] as const;

const PAGE_SIZE = 1000;

interface TableResult {
  table: string;
  status: "ok" | "error";
  rows?: number;
  bytes?: number;
  key?: string;
  error?: string;
}

interface PruneResult {
  prefix: string;
  objects_deleted: number;
  status: "ok" | "error";
  error?: string;
}

interface Manifest {
  date: string;
  started_at: string;
  finished_at: string;
  source: string;
  tables: TableResult[];
  pruned: PruneResult[];
  retention_weeks: number;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runBackup(env));
  },

  // Manual trigger for ad-hoc backups (e.g., before a risky migration) and for
  // post-deploy verification. Auth: `Authorization: Bearer <service-role-jwt>`.
  // Reuses the existing secret rather than provisioning a separate token.
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const auth = req.headers.get("Authorization") ?? "";
    const expected = `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`;
    if (!env.SUPABASE_SERVICE_ROLE_KEY || auth !== expected) {
      return new Response("Not found", { status: 404 });
    }
    ctx.waitUntil(runBackup(env));
    return new Response("backup started\n", { status: 202 });
  },
};

async function runBackup(env: Env): Promise<void> {
  const startedAt = new Date();
  const date = startedAt.toISOString().slice(0, 10); // YYYY-MM-DD
  const folder = `${env.BACKUP_PREFIX}/${date}`;

  console.log(`backup run start date=${date} tables=${TABLES.length}`);

  const tableResults: TableResult[] = [];
  for (const table of TABLES) {
    const result = await backupTable(env, table, folder);
    tableResults.push(result);
    if (result.status === "ok") {
      console.log(`  ok   ${table} rows=${result.rows} bytes=${result.bytes}`);
    } else {
      console.error(`  fail ${table} ${result.error}`);
    }
  }

  const pruned = await pruneOldBackups(env);

  const manifest: Manifest = {
    date,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    source: env.SUPABASE_URL,
    tables: tableResults,
    pruned,
    retention_weeks: Number(env.RETENTION_WEEKS),
  };

  await env.BACKUP_BUCKET.put(
    `${folder}/_manifest.json`,
    JSON.stringify(manifest, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );

  const errors = tableResults.filter((r) => r.status === "error").length;
  console.log(`backup run end errors=${errors} pruned=${pruned.length}`);
}

async function backupTable(env: Env, table: string, folder: string): Promise<TableResult> {
  try {
    const rows: unknown[] = [];
    let offset = 0;

    while (true) {
      const url =
        `${env.SUPABASE_URL}/rest/v1/${table}` +
        `?select=*&limit=${PAGE_SIZE}&offset=${offset}`;

      const res = await fetch(url, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        // Capture the PostgREST error body — these contain a `message` and
        // `hint` that name the bad column or operator. Without this the
        // original worker's manifest just said "400 Bad Request".
        const body = await res.text();
        return {
          table,
          status: "error",
          error: `${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
        };
      }

      const page = (await res.json()) as unknown[];
      rows.push(...page);

      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    const json = JSON.stringify(rows);
    const key = `${folder}/${table}.json`;
    await env.BACKUP_BUCKET.put(key, json, {
      httpMetadata: { contentType: "application/json" },
    });

    return { table, status: "ok", rows: rows.length, bytes: json.length, key };
  } catch (err) {
    return {
      table,
      status: "error",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

async function pruneOldBackups(env: Env): Promise<PruneResult[]> {
  const weeks = Number(env.RETENTION_WEEKS);
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - weeks * 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const results: PruneResult[] = [];

  try {
    const list = await env.BACKUP_BUCKET.list({
      prefix: `${env.BACKUP_PREFIX}/`,
      delimiter: "/",
    });

    for (const folder of list.delimitedPrefixes ?? []) {
      // folder looks like "backups/2026-04-01/"
      const datePart = folder.slice(env.BACKUP_PREFIX.length + 1, env.BACKUP_PREFIX.length + 11);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) continue;
      if (datePart >= cutoffStr) continue;

      try {
        let deleted = 0;
        let cursor: string | undefined;
        do {
          const contents = await env.BACKUP_BUCKET.list({ prefix: folder, cursor });
          if (contents.objects.length === 0) break;
          await Promise.all(contents.objects.map((o) => env.BACKUP_BUCKET.delete(o.key)));
          deleted += contents.objects.length;
          cursor = contents.truncated ? contents.cursor : undefined;
        } while (cursor);

        results.push({ prefix: folder, objects_deleted: deleted, status: "ok" });
        console.log(`pruned ${folder} (${deleted} objects)`);
      } catch (err) {
        results.push({
          prefix: folder,
          objects_deleted: 0,
          status: "error",
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
    }
  } catch (err) {
    results.push({
      prefix: `${env.BACKUP_PREFIX}/`,
      objects_deleted: 0,
      status: "error",
      error: err instanceof Error ? `prune-list-failed: ${err.message}` : String(err),
    });
  }

  return results;
}
