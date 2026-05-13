-- ────────────────────────────────────────────────────────────
-- Migration: tighten RLS on roster_presence (BATTLE-TEST #4)
-- Project:   eq-field-app
-- Version:   3.4.59
-- Created:   2026-05-13 (battle-test closeout Round 1)
-- Applied:   Demo  (ktmjmdzqrogauaevbktn) — pending (Royce on holidays)
--            Prod  (nspbmirochztcjijmcrx) — pending (Royce on holidays)
-- ────────────────────────────────────────────────────────────
-- BATTLE-TEST finding #4: presence policies were `USING (true)` for all
-- four operations. Within a tenant, any anon-key user could:
--   1. INSERT a presence row claiming to be a different manager
--      (impersonation — makes ghost "editing" outlines appear)
--   2. UPDATE another manager's row (refresh stale presence as them)
--   3. DELETE another manager's row (make them look offline)
--
-- HONEST CAVEAT: the EQ Field auth model uses the Supabase anon key
-- with no per-user JWT — auth is via tenant access code at the app
-- layer. So we cannot enforce "you can only mutate your own rows"
-- the way auth.uid()-based RLS normally would. The proper long-term
-- fix is in the Wave 5+ SSO conversation (MELBOURNE-SCALE-DESIGN.md
-- §7 Q7).
--
-- WHAT THIS MIGRATION ACTUALLY DOES:
--   - INSERT: require manager_name to exist in the managers table.
--     Eliminates "ghost manager" creation — you can't impersonate a
--     name that isn't a real manager. Limits the attack surface
--     to known-real names only.
--   - UPDATE/DELETE: stay open. Auth model can't distinguish "this
--     user is manager_name=X" from "this user is someone else
--     claiming to be X." Heartbeat cron + 15s client-side TTL
--     filter (presence.js) limits the blast radius — stale ghost
--     rows auto-cleanup within 5min via the existing pg_cron job.
--   - SELECT: stays open. Presence rendering needs to see all
--     supervisors in the same tenant to draw outlines.
--
-- TRADE-OFF: this is a partial fix that closes the most visible
-- bug class (fake manager presence) without changing the auth
-- model. Full impersonation prevention requires per-user identity.
-- ────────────────────────────────────────────────────────────

-- Drop and recreate INSERT policy with the manager_name existence check.
DROP POLICY IF EXISTS "presence_insert_anon" ON public.roster_presence;
CREATE POLICY "presence_insert_anon" ON public.roster_presence
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.managers m
      WHERE m.name = roster_presence.manager_name
    )
  );

-- Verify policies post-change (read-only output for the operator running this).
-- Expected: presence_select_anon=true, presence_insert_anon=manager-name-check,
--           presence_update_anon=true, presence_delete_anon=true.
SELECT
  policyname,
  cmd,
  qual AS using_clause,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'roster_presence'
ORDER BY policyname;
