-- Store the AI-generated title and comment as separate columns.
-- Gemini now returns structured JSON ({title, comment}), so the app no longer
-- needs to regex-parse generated_review. generated_review is still written in
-- the legacy "タイトル：...\nコメント：..." format for backward compatibility.
alter table public.tabelog_reviews add column if not exists review_title text;
alter table public.tabelog_reviews add column if not exists review_comment text;
