-- WhatsApp/Viber <-> in-app chat relay support.
-- Run this in the Supabase SQL Editor.

-- 1) Tag each chat message with the channel it arrived on: 'app' | 'whatsapp' | 'viber'.
alter table public.quote_messages add column if not exists via text;

-- 2) Map a phone number to the quote thread it is currently talking about, so
--    follow-up WhatsApp/Viber messages (which don't repeat the [CX-...] code)
--    still route to the right conversation.
create table if not exists public.wa_thread_map (
  phone text primary key,
  quote_request_id uuid not null references public.quote_requests(id) on delete cascade,
  role text not null check (role in ('buyer','supplier')),
  updated_at timestamptz not null default now()
);

-- The inbound webhook uses the Supabase service role (bypasses RLS), so no extra
-- grants/policies are needed for wa_thread_map. quote_messages keeps its existing
-- policies — the on-site chat already reads from it.
