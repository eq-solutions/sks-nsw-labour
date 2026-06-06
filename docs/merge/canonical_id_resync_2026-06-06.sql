-- ─────────────────────────────────────────────────────────────
-- Option-A re-sync: people.canonical_id := eq-canonical workers.id (by phone)
-- Target DB: sks-labour (nspbmirochztcjijmcrx) · table public.people
-- Source:    eq-canonical (jvknxcmbtrfnxfrwfimn) · public.workers.id ↔ phone
-- Date:      2026-06-06   Run by: Claude (autonomous, "complete everything")
--
-- Why: people.canonical_id held ORPHANED placeholder UUIDs that matched no
-- identity row anywhere. This sets the 28 active people whose phone uniquely
-- matches exactly one eq-canonical worker to that worker's real id, so the
-- v3.10.58 #sh= resolver (and Shell tokens carrying workers.id) resolve
-- deterministically. Phone-collision-guarded both sides (0 collisions found).
-- Only these 28 ids are touched; orphaned values on non-matching rows are
-- left as-is (they may reference a plane not reachable from here).
-- Idempotent: re-running sets the same values.
-- ─────────────────────────────────────────────────────────────

-- FORWARD
update public.people as p
set canonical_id = v.wid::uuid, canonical_synced_at = now()
from (values
  (250,'a1880e69-1df3-48ee-9507-feced5bed815'),(252,'fbac25b7-e0f8-4294-afd3-560f84ac489a'),
  (255,'1eca884c-12cc-4066-abeb-808db4fc0c7d'),(256,'7a6fde56-ab75-454c-aba8-61eceee283d4'),
  (257,'387e5491-4cbe-40e5-9d29-02f3674bfcb3'),(258,'28234ba6-5785-4e03-8c3c-66f9f71b4bfe'),
  (259,'d4a8ba17-ece5-48ee-9130-f35ea7df966b'),(260,'33149c1a-810a-41be-a08a-a172a5c7261e'),
  (262,'7514e57d-0334-4126-aca0-e60e118d906c'),(264,'6eee80cc-c4ad-4e00-ae36-7d7d082ceff8'),
  (267,'a864eb50-a1b5-4951-a9b1-889ef2a762f4'),(268,'d6d47b83-dba4-4f59-8d14-95ebb13ab86e'),
  (270,'8ad62b1c-1732-4dbf-b6a0-0530b8c56375'),(273,'b7b86bd5-67f7-4c80-a83e-0c00dede7eb9'),
  (274,'66e814cc-e828-429b-b213-586e43fcde74'),(275,'07d49024-edfa-4545-a554-0e974a84bf57'),
  (277,'8a8c388b-b8a0-48c5-9e75-77b9dc1355ae'),(278,'10dc5bd0-e16b-4d44-8ec3-a4d0eeae9825'),
  (279,'eaf5e355-4e93-4966-8d7d-1eebd93854c0'),(281,'4ea155a6-f948-4627-b6b2-5dc812861a05'),
  (282,'46eb653e-20a2-49e5-8157-b313ce21a87f'),(283,'06424899-7453-4562-89b1-b5b7dbe8da94'),
  (286,'b8fe6209-d24b-4e27-b50b-c2605be7ebf1'),(287,'302609b3-d30d-4e5e-8285-609f2953c5c2'),
  (292,'466e636f-ea3d-4246-b672-49a58686f3b2'),(294,'0d1ec173-9fdd-4713-b5c5-6ddf8962531b'),
  (295,'8d9e09cd-f78d-4872-9eb9-9f6413443ed0'),(296,'61691bf9-8a09-49dd-82bb-09947ecb6d92')
) as v(id, wid)
where p.id = v.id;

-- ROLLBACK (restore the prior orphaned values exactly)
-- update public.people as p
-- set canonical_id = v.old::uuid, canonical_synced_at = null
-- from (values
--   (250,'b40489f9-0c69-4158-8401-c4d93c1f2fe6'),(252,'1a2bda27-ba83-45a4-b9a4-d45495b78d34'),
--   (255,'d6f46e26-07bd-479b-ac2d-e347cd77314d'),(256,'dc9ee395-f3e5-45e0-a7fe-ba812f993100'),
--   (257,'28efcfbc-2f6d-4c45-af22-153e9c9e0cf8'),(258,'e3ba8b3e-bd74-432d-be2d-b7cbd6ef8a72'),
--   (259,'4aee9fe1-d859-4997-8ca6-bef7ad02b821'),(260,'34d1ec81-8269-4ec8-afe4-9e05c6135f5b'),
--   (262,'9520760d-a058-4c18-9ce9-60d7af4b9c20'),(264,'ab110038-32f5-4166-8a87-8b16942d4837'),
--   (267,'0b6701d2-1306-4172-91d4-895f6c5f9791'),(268,'6dad6dfb-6bf9-494c-832d-1b2bcc1e7ffe'),
--   (270,'52284a7d-3a40-4e1e-80fb-c88601c59e54'),(273,'48e4793a-7d18-4462-b499-fe68fbd87006'),
--   (274,'0bc8bfbe-6f17-4d46-9cd6-fc967c86f74d'),(275,'91cd5aff-2677-422f-994b-b8f66b6cfaca'),
--   (277,'2f828de0-1da7-4461-baba-890e8a1c7fe6'),(278,'594242f5-36ee-4dcb-a39b-02dc71d1b752'),
--   (279,'c599bf12-f63f-46ed-b613-485083ab53e0'),(281,'ec3a10e1-f6cf-4aea-be18-48bc8d040b13'),
--   (282,'54d73562-1ddc-42ec-a5db-d4f6abd26a0e'),(283,'e2d6056b-6900-479e-85b8-2d20c9cc2a00'),
--   (286,'4d58452c-ad58-4622-a8ff-594fe195e264'),(287,'faee4d6b-d4c2-4df4-a0db-dd6a87685163'),
--   (292,'80a432cb-6c4c-4a9b-8afc-9aefb7fff350'),(294,'58c958f9-44f0-4649-b1c4-8af7c5447718'),
--   (295,'aab44adb-273a-4057-93cc-6a75eab9321d'),(296,'bfa4d757-4969-49d1-8c86-76e0e429b184')
-- ) as v(id, old)
-- where p.id = v.id;
