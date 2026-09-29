# Project context: cost-governor-kit

Mapped on **2026-09-26** from connected GitHub, Vercel, and Supabase metadata. This file is a navigation aid; verify current code and service settings before acting.

## Identity and repository settings

- Repository: [lkopietz3-byte/cost-governor-kit](https://github.com/lkopietz3-byte/cost-governor-kit)
- Purpose: A library of pre-call dollar-ceiling arithmetic, cache-aware token pricing with caller-supplied rates, and helpers that count usage around a paid call. `withReserveConfirm` is advisory under concurrency; the strict `withCapacityReservation` orchestrator is only as strict as the storage adapter you write (none is shipped). It estimates cost, does not check provider billing, and a unit-count cap is not a variable-dollar budget. See the README's "Honest limits".
- GitHub visibility: **public**; default branch: **`main`**; archived: **no**.
- Product stage, owner, production health, and GitHub protection/settings beyond the fields above: **not verified**.

## Starting points

- Purpose source: [README.md](https://github.com/lkopietz3-byte/cost-governor-kit/blob/main/README.md)
- [package.json](https://github.com/lkopietz3-byte/cost-governor-kit/blob/main/package.json) contains scripts and declared dependencies; check the current file before using commands.
- Supabase references appear in indexed default-branch files; this does not establish which live project is connected.

## Service map

- No Vercel or Supabase project could be linked from the available evidence. This is an unknown connection state, not proof that the repository has no deployment or database.

A source reference, matching name, or past deployment does not establish a current production connection. No keys, environment values, database rows, or customer data are recorded here.

## For AI analysis

Read applicable `AGENTS.md` instructions, the purpose source, current implementation, and relevant tests before concluding how this project works. Check the current GitHub, Vercel, and Supabase state before making deployment, security, or business-status claims. State unknowns explicitly.
