-- Add shop location columns estimated from uploaded photos (EXIF GPS + AI).
-- shop_location: human-readable place description (e.g. "東京都中央区銀座付近")
-- latitude/longitude: EXIF GPS coordinates of the visit photos
ALTER TABLE public.tabelog_reviews
  ADD COLUMN IF NOT EXISTS shop_location TEXT,
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION CHECK (latitude >= -90 AND latitude <= 90),
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION CHECK (longitude >= -180 AND longitude <= 180);
