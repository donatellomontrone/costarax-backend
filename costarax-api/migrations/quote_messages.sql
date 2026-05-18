-- Quote messages: persistent chat thread per quote
-- NOTE: this table already exists in production with the schema below.
-- Running this migration on a fresh DB will create it correctly.

create type if not exists sender_role_enum as enum ('buyer', 'supplier', 'admin');

create table if not exists quote_messages (
  id                uuid        primary key default gen_random_uuid(),
  quote_request_id  uuid        not null references quote_requests(id) on delete cascade,
  sender_profile_id uuid        not null references auth.users(id) on delete cascade,
  sender_role       sender_role_enum not null,
  body              text        not null,
  created_at        timestamptz not null default now()
);

create index if not exists quote_messages_quote_request_id_idx
  on quote_messages(quote_request_id, created_at);

alter table quote_messages enable row level security;

-- Participants can read messages on their quotes
create policy "Quote messages visible to participants" on quote_messages for select
  using (
    exists (
      select 1 from quote_requests q
      where q.id = quote_messages.quote_request_id
        and (
          is_admin()
          or q.buyer_business_id  in (select user_business_ids())
          or q.supplier_id        in (select user_supplier_ids())
        )
    )
  );

-- Participants can insert messages on their quotes
create policy "Quote participants can message" on quote_messages for insert
  with check (
    exists (
      select 1 from quote_requests q
      where q.id = quote_messages.quote_request_id
        and (
          q.buyer_business_id in (select user_business_ids())
          or q.supplier_id    in (select user_supplier_ids())
          or is_admin()
        )
    )
  );
