-- One small key-value table. Row level security is on and there are no policies,
-- so only the server function (service role) can read or write it.
create table if not exists public.kv (
  coll text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (coll, id)
);
alter table public.kv enable row level security;
