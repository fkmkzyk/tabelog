-- Create tabelog_reviews table
create table public.tabelog_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  shop_name varchar not null,
  rating numeric not null check (rating >= 1.0 and rating <= 5.0),
  raw_memo text,
  generated_review text,
  status varchar not null default 'processing' check (status in ('processing', 'draft', 'posted')),
  created_at timestamptz not null default now()
);

-- Enable Row Level Security (RLS)
alter table public.tabelog_reviews enable row level security;

-- Policies for authenticated users to manage their own reviews
create policy "Users can view their own reviews"
  on public.tabelog_reviews
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their own reviews"
  on public.tabelog_reviews
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their own reviews"
  on public.tabelog_reviews
  for update
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can delete their own reviews"
  on public.tabelog_reviews
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- Note: The service_role key bypasses RLS, so the background generation worker
-- using service_role can update the generated_review and status columns freely.
