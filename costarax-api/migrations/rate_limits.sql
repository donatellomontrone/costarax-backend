-- Rate limiter table. Each row records one attempt for (bucket, identifier).
-- Used by lib/rate-limit.js to enforce per-IP / per-email caps on public endpoints.

create table if not exists rate_limits (
  id bigserial primary key,
  bucket text not null,
  identifier text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limits_lookup_idx
  on rate_limits (bucket, identifier, created_at desc);

-- Daily cleanup: drop rows older than 24h. Run from cron or pg_cron.
create or replace function rate_limits_prune() returns void language sql as $$
  delete from rate_limits where created_at < now() - interval '24 hours';
$$;

-- Service role only — nobody outside the backend should touch this.
alter table rate_limits enable row level security;
-- (No policies = no access for anon/authenticated; service role bypasses RLS.)
