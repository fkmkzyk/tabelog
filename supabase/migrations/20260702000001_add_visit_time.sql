-- Store the visit time (from the photos' EXIF shoot time) so the AI prompts
-- can use season / time-of-day context (e.g. lunch vs dinner) when generating.
alter table public.tabelog_reviews add column if not exists visit_time time;
