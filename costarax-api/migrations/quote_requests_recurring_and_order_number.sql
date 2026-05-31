-- Costarax — add recurring_freq + order_number to quote_requests
-- Run in Supabase SQL editor. Safe to re-run.
--
-- These two columns are referenced by app.html (the buyer "My quotes" list
-- SELECTs them — when missing, PostgREST errors and the list silently empties)
-- and written by the "recurring" quote action plus the cron scheduler
-- (recurring_freq) and the order-confirm flow (order_number). No earlier
-- migration created them, so add them idempotently here.

ALTER TABLE public.quote_requests ADD COLUMN IF NOT EXISTS recurring_freq text;
ALTER TABLE public.quote_requests ADD COLUMN IF NOT EXISTS order_number text;
