# SKS Labour Resilience Stack — Handoff Prompt
*Generated: 2026-05-20. Use this as the opening prompt for the next session.*

---

## Context

SKS Labour (`sks-nsw-labour.netlify.app`) is a live PWA used by ~15 supervisors and 53 field staff at SKS Technologies. A Netlify outage on 2026-05-19 took the app down before the weekly labour meeting. A 4-layer resilience stack is being built. Three of four layers are complete. This session finishes Layer 2.

**Repo**: `eq-solutions/sks-nsw-labour` — branch `main` — deploys to `sks-nsw-labour.netlify.app`  
**Supabase (SKS Prod)**: project `nspbmirochztcjijmcrx`, org_id `1eb831f9-aeae-4e57-b49e-9681e8f51e15`  
**Current app version**: `v3.4.73`

---

## Resilience Stack Status

| Layer | What | Status |
|-------|------|--------|
| **1** | Read-only snapshot (CF Worker → R2 → `supabase-backup-worker.royce-b3b.workers.dev/`) | ✅ LIVE |
| **2** | Offline write queue upgrade: localStorage → IndexedDB + Background Sync | ⏳ THIS SESSION |
| **3** | DR plan: PITR policy, daily JSON backup docs, drill checklist → context_files | ✅ Done |
| **4** | Comms: outage runbook, Slack templates, supervisor card → context_files | ✅ Done |

---

## Phase 2 — What Already Exists

`scripts/supabase.js` already has a working write queue. Key facts:

- In-memory array `_writeQueue = []`
- On network failure, writes are pushed to `_writeQueue` and persisted via `localStorage.setItem('eq_write_queue', JSON.stringify(_writeQueue))`
- On page load, queue is restored from localStorage and cleared
- `flushWriteQueue()` replays with exponential backoff (0.5s, 1s, 2s, 4s, 8s) and 5-retry limit
- `checkSupabaseHealth()` polls every 30s; on recovery calls `flushWriteQueue()`
- `window.addEventListener('online', ...)` also triggers flush
- Offline banner: `id="offline-banner"`, sync badge: `id="sync-status"`

**The gap**: `localStorage` is limited (~5MB), can be cleared by the browser under storage pressure, and does NOT survive a tab close + browser crash combo reliably. For field staff on mobile who close the app mid-entry, writes can be lost.

---

## Phase 2 — What Needs to Be Built

### Goal
Replace the `localStorage` persistence layer with **IndexedDB** for the write queue, and add **Background Sync API** to the service worker so queued writes replay even after the tab closes.

### Files to change

| File | Change |
|------|--------|
| `scripts/supabase.js` | Replace `localStorage.setItem/getItem('eq_write_queue', ...)` with IndexedDB reads/writes. Keep `_writeQueue` in-memory array as-is — only persistence changes. |
| `sw.js` | Add `sync` event handler for tag `'eq-write-queue'`. On sync event, post message to clients to call `flushWriteQueue()`. |
| `index.html` | Register sync tag when online status recovers (`navigator.serviceWorker.ready.then(sw => sw.sync.register('eq-write-queue'))`) |

### IDB schema (simple — one object store)

```javascript
// DB name: 'eq-offline', version: 1
// Object store: 'write_queue'
// keyPath: 'id' (auto-increment)
// Each record: { id, path, method, body, prefer, retries, ts }
```

### Key implementation notes

1. **Keep the in-memory `_writeQueue` array** — it drives all existing UI (sync badge count, `flushWriteQueue()` logic). IDB is only for persistence across sessions.
2. **IDB is async** — the save calls (`localStorage.setItem`) are currently synchronous. Replace with `await _idbSaveQueue()` in sbFetch catch block and after flushWriteQueue.
3. **On page load**, replace the `localStorage.getItem` block at line ~226 with an async IDB read that pushes restored items into `_writeQueue`.
4. **Background Sync** is not supported on iOS Safari — graceful fallback to the existing `window.addEventListener('online', ...)` flush is fine. Check `'SyncManager' in window` before registering.
5. **Version bump required** in 3 places: `scripts/app-state.js` (`APP_VERSION`), `sw.js` (`CACHE` key + comment), `index.html` (header comment + footer span). Bump to `v3.4.74`.

### Exact lines to replace in supabase.js

**Save (line ~206):**
```javascript
// BEFORE:
try { localStorage.setItem('eq_write_queue', JSON.stringify(_writeQueue)); } catch (e) {}
// AFTER:
_idbSaveQueue().catch(() => {});
```
*(same replacement at line ~255 inside flushWriteQueue)*

**Restore (lines ~226–231):**
```javascript
// BEFORE:
try {
  const saved = localStorage.getItem('eq_write_queue');
  if (saved) {
    const arr = JSON.parse(saved);
    if (Array.isArray(arr)) _writeQueue.push(...arr);
    localStorage.removeItem('eq_write_queue');
  }
} catch (e) {}

// AFTER: call _idbRestoreQueue() as an async IIFE at module load
(async () => { await _idbRestoreQueue(); })();
```

### IDB helper functions to add (top of supabase.js, after internals block)

```javascript
// ── IndexedDB write queue persistence ────────────────────────
const _IDB_NAME    = 'eq-offline';
const _IDB_STORE   = 'write_queue';
const _IDB_VERSION = 1;
let   _idb         = null;

function _idbOpen() {
  if (_idb) return Promise.resolve(_idb);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(_IDB_STORE))
        db.createObjectStore(_IDB_STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function _idbSaveQueue() {
  const db = await _idbOpen();
  const tx = db.transaction(_IDB_STORE, 'readwrite');
  const st = tx.objectStore(_IDB_STORE);
  st.clear();
  _writeQueue.forEach(item => st.put(item));
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

async function _idbRestoreQueue() {
  try {
    // Also migrate any legacy localStorage queue
    try {
      const legacy = localStorage.getItem('eq_write_queue');
      if (legacy) {
        const arr = JSON.parse(legacy);
        if (Array.isArray(arr)) _writeQueue.push(...arr);
        localStorage.removeItem('eq_write_queue');
      }
    } catch (_) {}

    const db = await _idbOpen();
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    const st = tx.objectStore(_IDB_STORE);
    const all = await new Promise((resolve, reject) => {
      const req = st.getAll();
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
    if (all && all.length) {
      _writeQueue.push(...all);
      st.clear();
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror    = e => reject(e.target.error);
    });
  } catch (e) {
    _sbLog('warn', 'idb-restore', e && e.message || e);
  }
}
```

### sw.js addition (after install/activate/fetch handlers)

```javascript
// ── Background Sync — replay write queue ─────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'eq-write-queue') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clients => {
          if (clients.length) clients[0].postMessage({ type: 'FLUSH_WRITE_QUEUE' });
        })
    );
  }
});
```

### index.html addition (inside the DOMContentLoaded or online event handler)

```javascript
// Register background sync when we come back online
window.addEventListener('online', () => {
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    navigator.serviceWorker.ready
      .then(sw => sw.sync.register('eq-write-queue'))
      .catch(() => {}); // Fallback already handled by window.online → flushWriteQueue
  }
});

// Listen for SW flush request
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'FLUSH_WRITE_QUEUE') flushWriteQueue();
  });
}
```

---

## Output Format

Produce a zip with only the changed files:
```
scripts/supabase.js   (IDB persistence, remove localStorage queue calls)
sw.js                 (sync event handler, bump CACHE to eq-field-v3.4.74)
index.html            (sync registration, SW message listener, bump version display)
scripts/app-state.js  (APP_VERSION = '3.4.74')
```

Syntax-check all JS with `node -c` before zipping. Royce uploads each file to GitHub manually.

---

## Hard Rules (non-negotiable)

1. Never push or deploy — Royce uploads files manually via GitHub web UI
2. SKS-only: navy `#1F335C`, purple `#7C77B9`, Arial font — do NOT apply EQ sky-blue / Plus Jakarta Sans
3. Never touch `nspbmirochztcjijmcrx` with INSERT/UPDATE/DELETE without explicit "SKS live" approval
4. Never cross-deploy between EQ Field (`eq-solutions/eq-field`) and SKS Labour repos
5. No credentials or API keys in frontend files
6. Real client names (Equinix, AirTrunk, AWS, Schneider, NEXTDC, Telstra, DigiCo, Ramsay) never in outputs

---

## Before Starting

**Confirm PAT is rotated** — the previous 3 PATs were compromised. A new PAT with `repo` scope is required for Royce to push files. Without it, files can still be uploaded manually via GitHub web UI (drag-and-drop works).

Also confirm: Supabase dashboard → `nspbmirochztcjijmcrx` → Settings → Backups → **PITR toggle is ON** (one-time setup, takes 2 minutes).

---

## Pending user actions (not blocked on code)

- [ ] Pin Slack message in #sks-nsw-operations (template in `sks/comms/labour-outage-comms.md` in eq-context)
- [ ] Sign up for Netlify status alerts: https://www.netlifystatus.com
- [ ] Sign up for Supabase status alerts: https://status.supabase.com
- [ ] Rotate all 3 compromised GitHub PATs
- [ ] Enable PITR in Supabase dashboard (2 min, free on Pro plan)
