-- reference-impl/supabase-usage-ledger.sql
--
-- Copy-and-adapt Postgres/Supabase migration implementing the ADVISORY
-- UsageLedger contract from ../src/reserveConfirm.ts as two RPCs:
--   1. usage_ledger_check_under_limit  -- read-only, Phase 1 (before the call)
--   2. usage_ledger_commit_usage       -- locked increment, Phase 2 (after the
--                                         call succeeds, and ONLY then)
--
-- It does NOT implement CapacityReservationLedger (the strict
-- reserve/confirm/release contract used by withCapacityReservation). This
-- kit ships no implementation of that contract.
--
-- What was verified: this file was applied to PostgreSQL 18 (PGlite, a
-- single-session WASM build) and each function was called for the
-- behaviors described below, including that a role without grants cannot
-- execute the functions. NOT verified: behavior under real concurrent
-- sessions, and a live Supabase project's role and default-privilege setup.
--
-- Generalized from cruise-almanac's api/chat.js, which fixed a real slot-leak
-- bug (AUDIT-2026-05-01-v2, finding F3-CC-E-4). Table and column names below
-- are intentionally generic ("usage_ledger", "key", "count").
--
-- WHY THE TWO-PHASE SPLIT MATTERS
-- --------------------------------
-- A naive limiter checks and increments in one step, BEFORE calling the
-- upstream API. If the upstream call then fails (a 5xx, a timeout) and the
-- client retries, the retry burns a SECOND slot for one logical attempt that
-- never succeeded. The two-phase split fixes that:
--   Phase 1 (usage_ledger_check_under_limit) runs BEFORE the upstream call.
--     It only READS the count. If the caller is at the limit, deny (e.g.
--     HTTP 429). A denial has no side effects, so re-checking is free.
--   Phase 2 (usage_ledger_commit_usage) runs AFTER the upstream call has
--     succeeded -- never speculatively and never if the call threw. It is the
--     only place the counter is incremented.
--
-- CONCURRENCY: WHAT THIS DOES AND DOES NOT DO
-- --------------------------------------------
-- Two concurrent requests can both pass Phase 1 and both make the paid
-- upstream call. Phase 1 cannot stop that, and neither can Phase 2: by the
-- time Phase 2 runs, the upstream call has already happened.
-- usage_ledger_commit_usage takes a row lock (SELECT ... FOR UPDATE) and
-- re-checks the limit, so the RECORDED count never exceeds p_limit. A commit
-- that finds the slot already taken returns committed = false and records
-- nothing: that call was paid for but is not counted. cruise-almanac's own
-- comment on the fix says the same thing: "this split only protects against
-- UPSTREAM-failure leakage, not concurrent same-tick claims". If the limit
-- must hold under concurrency, use withCapacityReservation with an adapter
-- that reserves capacity before the call.

create table if not exists usage_ledger (
  key         text primary key,
  count       integer not null default 0,
  -- The window this count belongs to (e.g. a calendar date for a daily cap,
  -- a month string like '2026-08' for a monthly cap, or a fixed sentinel
  -- such as 'lifetime'). Only equality (`<>`) is used on it.
  window_key  text not null,
  updated_at  timestamptz not null default now()
);

-- Deny direct table access to API roles. With RLS enabled and no policies,
-- roles that do not bypass RLS read and write nothing; the SECURITY DEFINER
-- functions below still work because they run as the table owner. (Supabase
-- grants API roles table privileges in `public` by default; this is the
-- guard for that. Not tested against a live Supabase project.)
alter table usage_ledger enable row level security;

comment on table usage_ledger is
  'Generic per-key usage counter for the advisory check-then-commit pattern '
  '(see src/reserveConfirm.ts). "key" is caller-defined, e.g. a user id or '
  '"<user_id>:<feature>". "window_key" is what makes the count reset, e.g. '
  'today''s date for a daily cap.';

-- Phase 1: check WITHOUT incrementing.
--
-- If no row exists yet for this key, or the stored window_key doesn't match
-- p_window (the window has rolled over), the caller is treated as being at
-- count 0. Nothing is written: the reset is persisted lazily by
-- usage_ledger_commit_usage. A NULL p_limit returns allowed = NULL.
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
    return query select (0 < p_limit), 0;
    return;
  end if;

  return query select (v_row.count < p_limit), v_row.count;
end;
$$;

comment on function usage_ledger_check_under_limit is
  'Phase 1 of check-then-commit. READ-ONLY. Call BEFORE the guarded call. '
  'If allowed is not true, deny the request with zero side effects.';

-- Phase 2: locked increment, called ONLY after the guarded call succeeds.
--
-- INSERT ... ON CONFLICT plus SELECT ... FOR UPDATE make the
-- read-check-write a single unit under the row lock, so the recorded count
-- never exceeds p_limit. Returns committed = false (and records nothing)
-- when the limit is already reached; see CONCURRENCY above for what that
-- means. A window rollover is persisted here.
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
    -- Window rolled over since the last commit: this is the first usage of
    -- the new window, unless the limit allows none at all.
    if not (0 < p_limit) then
      return query select false, 0;
      return;
    end if;

    update usage_ledger
       set count = 1, window_key = p_window, updated_at = now()
     where key = p_key
    returning * into v_row;

    return query select true, v_row.count;
    return;
  end if;

  if not (v_row.count < p_limit) then
    -- The slot was taken between this caller's Phase 1 and this Phase 2.
    -- The guarded call already happened and its cost is real; it is not
    -- recorded, so the ledger undercounts real usage in this case.
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
  'Phase 2 of check-then-commit. Locked increment. Call ONLY after the '
  'guarded call has succeeded. committed = false means the call was not '
  'recorded because the limit was already reached.';

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Because
-- these functions are SECURITY DEFINER, that would let any role (including
-- an anonymous API role) increment anyone's counter. Revoke it, then grant
-- only the role your server-side code uses (commonly `service_role` on
-- Supabase). Adjust to your own role model.
revoke execute on function usage_ledger_check_under_limit(text, integer, text) from public;
revoke execute on function usage_ledger_commit_usage(text, integer, text) from public;

do $$
declare
  r text;
begin
  -- Supabase's API roles, when present. Skipped on plain Postgres.
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function usage_ledger_check_under_limit(text, integer, text) from %I', r);
      execute format('revoke execute on function usage_ledger_commit_usage(text, integer, text) from %I', r);
    end if;
  end loop;
end;
$$;

grant execute on function usage_ledger_check_under_limit(text, integer, text) to service_role;
grant execute on function usage_ledger_commit_usage(text, integer, text) to service_role;

-- ---------------------------------------------------------------------------
-- Example UsageLedger adapter (TypeScript) for these two RPCs via the
-- Supabase client. A sketch: src/referenceImplPglite.test.ts extracts this
-- code, strips its types and runs it against the functions above through a
-- stub of the client's rpc() method, inside withReserveConfirm. It was not
-- run with @supabase/supabase-js or against a live Supabase project.
--
-- UsageLedger.commitUsage(key) receives no limit, so the adapter closes over
-- the limit. Build one adapter per (window, limit) and pass the SAME limit to
-- withReserveConfirm; otherwise Phase 2 re-checks a different limit.
--
--   import type { UsageLedger } from 'cost-governor-kit/reserveConfirm';
--   import { createClient } from '@supabase/supabase-js';
--
--   const supabase = createClient(url, serviceRoleKey);
--
--   export function supabaseUsageLedger(windowKey: string, limit: number): UsageLedger {
--     return {
--       async checkUnderLimit(key) {
--         const { data, error } = await supabase.rpc('usage_ledger_check_under_limit', {
--           p_key: key,
--           p_limit: limit,
--           p_window: windowKey,
--         });
--         if (error) throw error;
--         return data?.[0]?.allowed === true;
--       },
--       async commitUsage(key) {
--         const { data, error } = await supabase.rpc('usage_ledger_commit_usage', {
--           p_key: key,
--           p_limit: limit,
--           p_window: windowKey,
--         });
--         if (error) throw error;
--         const row: { committed?: unknown } | undefined = Array.isArray(data) ? data[0] : undefined;
--         if (row?.committed !== true) {
--           // Not recorded: the limit was reached concurrently (committed is
--           // false), or the RPC answered with something unexpected. The paid
--           // call already happened, so REJECT. withReserveConfirm catches the
--           // rejection and returns the paid result with commitError set
--           // instead of discarding it; check for it with
--           // Object.hasOwn(result, 'commitError'), then reconcile. Do not
--           // repeat the paid call. The message leaves the key out on purpose.
--           throw new Error(
--             row?.committed === false
--               ? 'usage not recorded: limit reached concurrently'
--               : 'usage not recorded: unexpected response from usage_ledger_commit_usage',
--           );
--         }
--       },
--     };
--   }
--
--   const limit = 5;
--   const result = await withReserveConfirm(
--     supabaseUsageLedger(today, limit), `${userId}:${today}`, limit, () => callYourLlmApi(prompt),
--   );
--   if (result.allowed && Object.hasOwn(result, 'commitError')) {
--     // The paid result is in result.result; usage was NOT recorded.
--   }
