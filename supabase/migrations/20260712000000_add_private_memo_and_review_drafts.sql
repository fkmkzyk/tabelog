-- Two-layer review: a private memo per review ("次は塩を頼む" etc.) that is
-- never posted anywhere and never sent to the AI prompts.
alter table public.tabelog_reviews add column if not exists private_memo text;

-- Multi-draft generation: all generated variants ([{title, comment}, ...]).
-- review_title / review_comment hold the currently selected variant.
alter table public.tabelog_reviews add column if not exists review_drafts jsonb;
