-- Photo thumbnails: store lightweight (long edge 320px JPEG) thumbnails of the
-- uploaded photos in a private Storage bucket so review cards can show them.
-- Full-resolution images are still never persisted.

-- Storage paths of the review's thumbnails ('{user_id}/{review_id}/{0..2}.jpg')
alter table public.tabelog_reviews add column if not exists photo_thumbs text[];

-- Private bucket for review thumbnails
insert into storage.buckets (id, name, public)
values ('review-thumbs', 'review-thumbs', false)
on conflict (id) do nothing;

-- Storage RLS: only the owner (first path segment = auth.uid()) can access
create policy "Users can view own review thumbs"
  on storage.objects for select to authenticated
  using (bucket_id = 'review-thumbs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can upload own review thumbs"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'review-thumbs' and (storage.foldername(name))[1] = auth.uid()::text);

-- upsert:true uploads perform an update when the object already exists
create policy "Users can update own review thumbs"
  on storage.objects for update to authenticated
  using (bucket_id = 'review-thumbs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'review-thumbs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can delete own review thumbs"
  on storage.objects for delete to authenticated
  using (bucket_id = 'review-thumbs' and (storage.foldername(name))[1] = auth.uid()::text);
