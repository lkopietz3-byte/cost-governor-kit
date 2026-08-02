-- reference-impl/supabase-usage-ledger.sql
--
-- Ready-to-copy Postgres/Supabase migration implementing the UsageLedger
-- contract from ../src/reserveConfirm.ts as two RPCs:
--   1. usage_ledger_check_under_limit  — read-only, Phase 1 (before the call)
--   2. usage_ledger_commit_usage       — atomic increment, Phase 2 (after the
--                                        call succeeds, and ONLY then)
--
-- Generalized from cruise-almanac's api/chat.js, which fixed a real slot-leak
-- bug (AUDIT-2026-05-01-v2, finding F3-CC-E-4). Table and column names below
-- are intentionally generic ("usage_ledger", "key", "count") rather than
-- product-specific ("ai_usage", "daily_count", etc.) — this file is a
-- reference implementation of a portable contract, not a copy of any one
-- app's schema.
--
-- WHY THE TWO-PHASE SPLIT MATTERS
-- --------------------------------
-- A naive limiter reads the count, checks it, and increments it all in one
-- step, BEFORE calling the upstream API:
--
--   check-and-increment(user)   -- one step, before the call
--   call_upstream_api()         -- if THIS fails...
--
-- If the upstream call then fails (a 5xx, a timeout, a dropped connection)
-- and the client retries — completely normal client behavior — the retry
-- burns a SECOND slot for what was really one logical usage attempt that
-- never succeeded even once. A single flaky request plus its retry can burn
-- a user's entire daily quota with zero real usage to show for it.
--
-- The fix is the two-phase split below:
--   Phase 1 (usage_ledger_check_under_limit) runs BEFORE the upstream call.
--     It only READS the count — it never mutates state. If the caller is
--     over the limit, deny (e.g. HTTP 429) immediately. Because this phase
--     has no side effects, a client retry of a *denial* is free to re-check
--     safely.
--   Phase 2 (usage_ledger_commit_usage) runs AFTER the upstream call has
--     ACTUALLY SUCCEEDED — never speculatively, never before the call, and
--     never if the call threw. This is the only place the counter is
--     incremented.
--
-- A failed upstream call therefore costs at most a Phase-1 read (free) on
-- retry — never a second increment for one real usage.
--
-- CONCURRENCY: usage_ledger_commit_usage re-validates the limit at commit
-- time using `SELECT ... FOR UPDATE`, closing the race where two concurrent
-- requests both pass Phase 1 in the same tick (Phase 1 alone cannot prevent
-- that race — only Phase 2's row lock can). This mirrors cruise-almanac's
-- own comment on the fix: "Cross-tick races are still resolved at increment
-- time (the bump RPC has the row lock); the [phase] split only protects
-- against UPSTREAM-failure leakage, not concurrent same-tick claims" — i.e.
-- the two-phase split and the row-lock re-check solve two DIFFERENT
-- problems, and you need both.

create table if not exists usage_ledger (
  key         text primary key,
  count       integer not null default 0,
  -- The window this count belongs to (e.g. a calendar date for a daily cap,
  -- a month string like '2026-08' for a monthly cap, or a fixed sentinel
  -- value like 'lifetime' if you never want it to roll over). Whatever you
  -- pass as p_window must be comparable with `<>` and sortable is not
  -- required.
  window_key  text not null,
  updated_at  timestamptz not null default now()
);

comment on table usage_ledger is
  'Generic per-key usage counter for the reserve-then-confirm pattern '
  '(see src/reserveConfirm.ts). "key" is caller-defined -- e.g. a user id '
  'for a global cap, or "<user_id>:<feature>" for a per-feature cap. '
  '"window_key" is what makes the count reset -- e.g. today''s date for a '
  'daily cap. This table intentionally has no app-specific columns: the '
  'contract in reserveConfirm.ts is database-agnostic, and this is only '
  'the Postgres/Supabase reference implementation of it.';

-- Phase 1: check WITHOUT incrementing.
--
-- If no row exists yet for this key, or the stored window_key doesn't match
-- p_window (the window has rolled over -- e.g. it's a new day), the caller
-- is treated as under the limit at count 0. Note this does NOT write
-- anything -- the actual reset is persisted lazily by
-- usage_ledger_commit_usage the next time it's called for this key. A
-- read-only check must never mutate state, or a client that checks
-- repeatedly without ever calling commit (e.g. because every one of its
-- calls happens to fail) would still be silently rolling the window forward.
create or replace function usage_ledger_check_under_limit(
  p_key    text,
  p_limit  integer,
  p_window text
)
returns table (allowed boolean, current_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row usage_ledger%rowtype;
begin
  select * into v_row from usage_ledger where key = p_key;

  if v_row.key is null or v_row.window_key <> p_window then
    -- No row yet, or stale window (e.g. yesterday's count) -- treat as a
    -- fresh window at count 0, without writing anything.
    return query select true, 0;
    return;
  end if;

  return query select (v_row.count < p_limit), v_row.count;
end;
$$;

comment on function usage_ledger_check_under_limit is
  'Phase 1 of reserve-then-confirm. READ-ONLY -- never increments. Call '
  'this BEFORE making the guarded (e.g. upstream LLM) call. If allowed is '
  'false, deny the request (e.g. HTTP 429) with zero side effects.';

-- Phase 2: atomic increment, called ONLY after the guarded call succeeds.
--
-- Uses INSERT ... ON CONFLICT plus SELECT ... FOR UPDATE so the
-- read-check-write is a single atomic unit under the row lock, closing the
-- race between two concurrent requests that both passed Phase 1 in the same
-- tick. Re-validates window_key so a window rollover is safely persisted
-- here (the one place that's allowed to mutate the row).
create or replace function usage_ledger_commit_usage(
  p_key    text,
  p_limit  integer,
  p_window text
)
returns table (committed boolean, new_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row usage_ledger%rowtype;
begin
  insert into usage_ledger (key, count, window_key)
  values (p_key, 0, p_window)
  on conflict (key) do nothing;

  select * into v_row from usage_ledger where key = p_key for update;

  if v_row.window_key <> p_window then
    -- Window rolled over since the last commit (e.g. it's a new day) --
    -- this commit is the first usage of the new window.
    update usage_ledger
       set count = 1, window_key = p_window, updated_at = now()
     where key = p_key
    returning * into v_row;

    return query select true, v_row.count;
    return;
  end if;

  if v_row.count >= p_limit then
    -- A concurrent request already filled the last slot between this
    -- caller's own Phase 1 check and this Phase 2 commit. The caller's
    -- guarded call already happened by this point (rare, and the cost of
    -- it is real and already incurred) -- but we refuse to record MORE
    -- usage than the limit allows, so the ledger itself never over-counts.
    return query select false, v_row.count;
    return;
  end if;

  update usage_ledger
     set count = count + 1, updated_at = now()
   where key = p_key
  returning * into v_row;

  return query select true, v_row.count;
end;
$$;

comment on function usage_ledger_commit_usage is
  'Phase 2 of reserve-then-confirm. Atomically increments. Call this ONLY '
  'after the guarded call has actually succeeded -- never speculatively, '
  'never before the call, and never if the call threw.';

-- Adjust these grants to your own role model. At minimum, the role your
-- serverless/edge function authenticates as (commonly `service_role` on
-- Supabase) needs EXECUTE on both functions.
grant execute on function usage_ledger_check_under_limit(text, integer, text) to service_role;
grant execute on function usage_ledger_commit_usage(text, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- Example UsageLedger adapter (TypeScript) implementing src/reserveConfirm.ts
-- against these two RPCs via the Supabase client. Copy into your app and
-- adjust the client import/init to match your setup.
--
--   import type { UsageLedger } from 'cost-governor-kit/reserveConfirm';
--   import { createClient } from '@supabase/supabase-js';
--
--   const supabase = createClient(url, serviceRoleKey);
--
--   export function supabaseUsageLedger(windowKey: string): UsageLedger {
--     return {
--       async checkUnderLimit(key, limit) {
--         const { data, error } = await supabase.rpc('usage_ledger_check_under_limit', {
--           p_key: key,
--           p_limit: limit,
--           p_window: windowKey,
--         });
--         if (error) throw error;
--         return Boolean(data?.[0]?.allowed);
--       },
--       async commitUsage(key) {
--         const { error } = await supabase.rpc('usage_ledger_commit_usage', {
--           p_key: key,
--           p_limit: Number.MAX_SAFE_INTEGER, // re-check uses the caller's real limit; see note below
--           p_window: windowKey,
--         });
--         if (error) throw error;
--       },
--     };
--   }
--
-- Note: pass the SAME p_limit to commitUsage that you passed to
-- checkUnderLimit for that request -- it's what lets Phase 2 close the
-- concurrent-same-tick race described above. The Number.MAX_SAFE_INTEGER in
-- the sketch above is a placeholder; thread the real limit through instead.
