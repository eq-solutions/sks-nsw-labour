-- Labour Hire "would rehire" rating (1-5), captured at archive time or later
-- from the People page. Nullable — most people (Direct/Apprentice, and any
-- unrated Labour Hire) never set it.
alter table public.people
  add column if not exists rating smallint;

alter table public.people
  add constraint people_rating_range
  check (rating is null or (rating between 1 and 5));
