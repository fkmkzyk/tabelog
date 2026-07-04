-- GPS-based place auto-identification: store the Google Place the user selected
-- (candidate chips from the photo's EXIF GPS). Raw photo GPS is NOT stored.
-- place_id is a stable key for future features (revisit detection, visited map).
alter table public.tabelog_reviews add column if not exists place_id text;
alter table public.tabelog_reviews add column if not exists place_lat double precision;
alter table public.tabelog_reviews add column if not exists place_lng double precision;
alter table public.tabelog_reviews add column if not exists place_genre text;
