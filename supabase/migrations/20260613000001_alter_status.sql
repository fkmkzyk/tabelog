-- Drop the old constraint that limits status values
alter table public.tabelog_reviews drop constraint if exists tabelog_reviews_status_check;

-- Add a new constraint supporting partial posting statuses
alter table public.tabelog_reviews add constraint tabelog_reviews_status_check check (
  status in ('processing', 'draft', 'posted_tabelog', 'posted_google', 'posted')
);
