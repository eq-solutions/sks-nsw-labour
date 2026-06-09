-- Migration: eq_field_shift_payload
-- Created: 2026-06-07
-- Target:  SKS LIVE operational DB (nspbmirochztcjijmcrx)
-- Purpose: Build the enriched payload for the EQ Shell AI-briefing "On Shift Now"
--          panel from the live SKS roster. Returns the existing shape
--          (assignments / scheduled_count / leave_count) PLUS:
--            - sites:    { <site code> : <human site name> }   (sites.abbr -> sites.name)
--            - on_shift: [ { name, site }, ... ]               (bounded, spread one
--                        person per busiest site so the headline names span sites)
--
-- Roster model: public.schedule has one row per person/week; the day cells
--   mon..sun hold a site code (resolved via public.sites.abbr) OR a leave/admin
--   token (A/L, RDO, TAFE, SICK, N/A ...) which has no matching site and is
--   therefore counted as leave, not on-shift.
--
-- SECURITY INVOKER (default); EXECUTE granted to service_role only.
-- This function is consumed by eq_field_emit_shift_started (see the emitter
-- migration) and can be called directly for backfill / inspection:
--   SELECT public.eq_field_shift_payload('01.06.26', 'mon');

CREATE OR REPLACE FUNCTION public.eq_field_shift_payload(
  p_week           text,
  p_day            text,
  p_on_shift_limit integer DEFAULT 6
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH cells AS (
    SELECT s.name AS person,
           nullif(trim(
             CASE lower(p_day)
               WHEN 'mon' THEN s.mon WHEN 'tue' THEN s.tue WHEN 'wed' THEN s.wed
               WHEN 'thu' THEN s.thu WHEN 'fri' THEN s.fri WHEN 'sat' THEN s.sat
               WHEN 'sun' THEN s.sun
             END
           ), '') AS code
    FROM public.schedule s
    WHERE s.week = p_week
      AND s.deleted_at IS NULL
  ),
  assigned AS (
    SELECT person, code FROM cells WHERE code IS NOT NULL
  ),
  resolved AS (
    SELECT a.person, a.code, si.name AS site_name
    FROM assigned a
    LEFT JOIN public.sites si
      ON upper(si.abbr) = upper(a.code) AND si.deleted_at IS NULL
  ),
  assignments AS (
    SELECT coalesce(jsonb_object_agg(code, n), '{}'::jsonb) AS m
    FROM (SELECT code, count(*) n FROM assigned GROUP BY code) z
  ),
  sites_map AS (
    SELECT coalesce(jsonb_object_agg(code, site_name), '{}'::jsonb) AS m
    FROM (SELECT DISTINCT code, site_name FROM resolved WHERE site_name IS NOT NULL) z
  ),
  sc AS (
    SELECT code, count(*) n FROM resolved WHERE site_name IS NOT NULL GROUP BY code
  ),
  ranked AS (
    SELECT r.person, r.site_name, r.code,
           row_number() OVER (PARTITION BY r.code ORDER BY r.person) AS rn
    FROM resolved r
    WHERE r.site_name IS NOT NULL
  ),
  on_shift AS (
    SELECT coalesce(
             jsonb_agg(jsonb_build_object('name', person, 'site', site_name)
                       ORDER BY rn, n DESC, site_name, person), '[]'::jsonb) AS arr
    FROM (
      SELECT rk.person, rk.site_name, rk.rn, sc.n
      FROM ranked rk
      JOIN sc ON sc.code = rk.code
      ORDER BY rk.rn, sc.n DESC, rk.site_name, rk.person
      LIMIT greatest(p_on_shift_limit, 0)
    ) x
  )
  SELECT jsonb_build_object(
    'week',            p_week,
    'day',             lower(p_day),
    'assignments',     (SELECT m FROM assignments),
    'scheduled_count', (SELECT count(*) FROM assigned),
    'leave_count',     (SELECT count(*) FROM resolved WHERE site_name IS NULL),
    'sites',           (SELECT m FROM sites_map),
    'on_shift',        (SELECT arr FROM on_shift)
  );
$$;

REVOKE ALL ON FUNCTION public.eq_field_shift_payload(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.eq_field_shift_payload(text, text, integer) TO service_role;
