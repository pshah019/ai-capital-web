-- Live news feed (Work in Progress tab) — run once in the Supabase SQL editor.
-- Stories are kept 7 days (pruned by /api/news).
-- Same pattern as schema_stocks.sql: the Vercel function /api/news uses the anon key server side.

create table if not exists public.news_items (
  id            text primary key,              -- source + hash of the feed guid
  src           text not null,                 -- FJ | IL | CNBC | PRN | GNW | BW
  title         text not null,
  link          text not null default '',
  published_at  timestamptz not null,
  fetched_at    timestamptz not null default now(),
  hot           boolean not null default false,
  snip          text not null default ''       -- short summary (search only)
);
create index if not exists news_items_pub_idx on public.news_items (published_at desc);
create index if not exists news_items_fetch_idx on public.news_items (fetched_at desc);

create table if not exists public.news_meta (
  k   text primary key,
  at  timestamptz not null default now()
);

alter table public.news_items enable row level security;
alter table public.news_meta  enable row level security;

drop policy if exists ni_anon_select on public.news_items;
drop policy if exists ni_anon_insert on public.news_items;
drop policy if exists ni_anon_delete on public.news_items;
create policy ni_anon_select on public.news_items for select to anon using (true);
create policy ni_anon_insert on public.news_items for insert to anon with check (true);
create policy ni_anon_delete on public.news_items for delete to anon using (published_at < now() - interval '3 days');

drop policy if exists nm_anon_select on public.news_meta;
drop policy if exists nm_anon_insert on public.news_meta;
drop policy if exists nm_anon_update on public.news_meta;
create policy nm_anon_select on public.news_meta for select to anon using (true);
create policy nm_anon_insert on public.news_meta for insert to anon with check (true);
create policy nm_anon_update on public.news_meta for update to anon using (true) with check (true);

-- Keep the archive filling while nobody has the page open: pull every 5 minutes.
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.unschedule('ai-news-refresh') where exists (select 1 from cron.job where jobname = 'ai-news-refresh');
select cron.schedule('ai-news-refresh', '*/5 * * * *',
  $$select net.http_get('https://ai-capital-web.vercel.app/api/news?refresh=1&limit=1')$$);
