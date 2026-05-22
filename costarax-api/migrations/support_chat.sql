-- ============================================================
-- Support chat — persistent AI chat with human handoff.
-- A chat starts in 'ai' status; the AI replies until the buyer/supplier
-- asks for a human, then status → 'escalated' and an admin can take it.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.support_chats (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_role       TEXT,                                   -- 'buyer' | 'supplier' | 'admin'
  status          TEXT NOT NULL DEFAULT 'ai',             -- 'ai' | 'escalated' | 'closed'
  assigned_admin  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sc_user_idx   ON public.support_chats (user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS sc_status_idx ON public.support_chats (status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS public.support_messages (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     BIGINT NOT NULL REFERENCES public.support_chats(id) ON DELETE CASCADE,
  sender      TEXT   NOT NULL,                            -- 'user' | 'ai' | 'admin' | 'system'
  body        TEXT   NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sm_chat_idx ON public.support_messages (chat_id, created_at);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.support_chats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- Helper: is the current user an admin / super_admin?
CREATE OR REPLACE FUNCTION public.is_costarax_admin()
RETURNS boolean AS $$
  SELECT role IN ('admin','super_admin') FROM public.profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Chats: owners read/write their own; admins see all.
DROP POLICY IF EXISTS "sc_owner_read"   ON public.support_chats;
DROP POLICY IF EXISTS "sc_owner_write"  ON public.support_chats;
DROP POLICY IF EXISTS "sc_admin_all"    ON public.support_chats;

CREATE POLICY "sc_owner_read"  ON public.support_chats FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_costarax_admin());
CREATE POLICY "sc_owner_write" ON public.support_chats FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "sc_admin_all"   ON public.support_chats FOR UPDATE TO authenticated
  USING (public.is_costarax_admin());

-- Messages: owners read/write own chat's messages; admins see all.
DROP POLICY IF EXISTS "sm_chat_read"   ON public.support_messages;
DROP POLICY IF EXISTS "sm_chat_write"  ON public.support_messages;

CREATE POLICY "sm_chat_read" ON public.support_messages FOR SELECT TO authenticated
  USING (
    chat_id IN (SELECT id FROM public.support_chats WHERE user_id = auth.uid())
    OR public.is_costarax_admin()
  );
CREATE POLICY "sm_chat_write" ON public.support_messages FOR INSERT TO authenticated
  WITH CHECK (
    (sender = 'user' AND chat_id IN (SELECT id FROM public.support_chats WHERE user_id = auth.uid()))
    OR (sender = 'admin' AND public.is_costarax_admin())
  );

GRANT SELECT, INSERT, UPDATE ON public.support_chats TO authenticated;
GRANT SELECT, INSERT ON public.support_messages TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.support_chats_id_seq    TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.support_messages_id_seq TO authenticated;

-- The backend uses the service_role key (supabaseAdmin) which bypasses RLS
-- but still needs the table-level GRANT, otherwise PostgREST/Postgres
-- returns 'permission denied for table'.
GRANT ALL ON public.support_chats    TO service_role;
GRANT ALL ON public.support_messages TO service_role;
GRANT ALL ON SEQUENCE public.support_chats_id_seq    TO service_role;
GRANT ALL ON SEQUENCE public.support_messages_id_seq TO service_role;
