-- Timeless WiFi - Supabase schema. Run in Supabase > SQL Editor.
-- Safe to run on an existing "transactions" table: it only adds what's missing.

create table if not exists public.transactions (
  id text primary key,                         -- Daraja CheckoutRequestID
  created_at timestamptz not null default now()
);

alter table public.transactions
  add column if not exists merchant_request_id text,
  add column if not exists status text not null default 'PENDING',      -- PENDING | SUCCESS | FAILED
  add column if not exists phone text,
  add column if not exists mac text,
  add column if not exists client_ip text,
  add column if not exists package_id text,
  add column if not exists amount integer,
  add column if not exists paid_amount integer,
  add column if not exists receipt text,
  add column if not exists reason text,
  add column if not exists username text,
  add column if not exists password text,
  add column if not exists paid_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists mikrotik_sync text default 'PENDING',        -- PENDING | DONE | REMOVED
  add column if not exists confirmed_by text,                           -- callback | query | admin-*
  add column if not exists last_query_at timestamptz,
  add column if not exists updated_at timestamptz default now();

create index if not exists transactions_status_sync_idx on public.transactions (status, mikrotik_sync, created_at);
create index if not exists transactions_receipt_idx on public.transactions (receipt);
create index if not exists transactions_expires_idx on public.transactions (expires_at);
create index if not exists transactions_created_idx on public.transactions (created_at desc);

-- The backend uses the service-role key. Lock the table down for everyone else.
alter table public.transactions enable row level security;
