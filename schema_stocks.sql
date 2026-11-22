-- Stock Research Data tab — run once in the Supabase SQL editor.
-- Same pattern as sector-rotation-scanner: the Vercel functions use the anon key server side.

create table if not exists public.stock_research_runs (
  id          bigserial primary key,
  run_at      timestamptz not null default now(),
  list_name   text not null default 'Default',
  symbols     jsonb not null,            -- ["AAPL","MSFT",...]
  rows        jsonb not null             -- one object per ticker (price, highs, YTD, IPO, category)
);
create index if not exists stock_research_runs_list_idx on public.stock_research_runs (list_name, run_at desc);

create table if not exists public.stock_watchlists (
  id          bigserial primary key,
  name        text not null unique,      -- unique so saving the same name overwrites
  symbols     jsonb not null,
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.stock_research_runs enable row level security;
alter table public.stock_watchlists  enable row level security;

drop policy if exists srr_anon_select on public.stock_research_runs;
drop policy if exists srr_anon_insert on public.stock_research_runs;
create policy srr_anon_select on public.stock_research_runs for select to anon using (true);
create policy srr_anon_insert on public.stock_research_runs for insert to anon with check (true);

drop policy if exists sw_anon_select on public.stock_watchlists;
drop policy if exists sw_anon_insert on public.stock_watchlists;
drop policy if exists sw_anon_update on public.stock_watchlists;
drop policy if exists sw_anon_delete on public.stock_watchlists;
create policy sw_anon_select on public.stock_watchlists for select to anon using (true);
create policy sw_anon_insert on public.stock_watchlists for insert to anon with check (true);
create policy sw_anon_update on public.stock_watchlists for update to anon using (true) with check (true);
create policy sw_anon_delete on public.stock_watchlists for delete to anon using (true);
