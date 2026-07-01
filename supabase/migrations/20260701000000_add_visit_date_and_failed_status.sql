-- Add the visit_date column used by the app since the EXIF visit-date feature.
-- (It may already exist on environments where it was added manually.)
alter table public.tabelog_reviews add column if not exists visit_date date;

-- Extend the status constraint with 'failed' so that server-side generation
-- errors can be recorded instead of leaving records stuck in 'processing'.
alter table public.tabelog_reviews drop constraint if exists tabelog_reviews_status_check;

alter table public.tabelog_reviews add constraint tabelog_reviews_status_check check (
  status in ('processing', 'draft', 'failed', 'posted_tabelog', 'posted_google', 'posted')
);
