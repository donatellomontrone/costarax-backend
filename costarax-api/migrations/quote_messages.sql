-- Quote messages: persistent chat thread per quote
create table if not exists quote_messages (
  id          uuid        primary key default gen_random_uuid(),
  quote_id    uuid        not null references quote_requests(id) on delete cascade,
  sender_type text        not null check (sender_type in ('buyer','supplier')),
  sender_name text,
  text        text        not null,
  created_at  timestamptz not null default now()
);

create index if not exists quote_messages_quote_id_idx on quote_messages(quote_id, created_at);

alter table quote_messages enable row level security;

-- Buyers: read/write messages on their own quotes
create policy "buyer_quote_messages" on quote_messages for all
  using (
    exists (
      select 1 from quote_requests qr
      join businesses b on b.id = qr.buyer_business_id
      where qr.id = quote_messages.quote_id
        and b.contact_email = auth.email()
    )
  );

-- Suppliers: read/write messages on their own quotes
create policy "supplier_quote_messages" on quote_messages for all
  using (
    exists (
      select 1 from quote_requests qr
      join suppliers s on s.id = qr.supplier_id
      join profiles p on p.supplier_id = s.id
      where qr.id = quote_messages.quote_id
        and p.user_id = auth.uid()
    )
  );

-- Admins: full access
create policy "admin_quote_messages" on quote_messages for all
  using ( exists (select 1 from profiles where user_id = auth.uid() and role = 'admin') );
