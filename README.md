# EDGAR Fund Tracker — Autonomous Build Kit

A spec-first starter kit for building a WhaleWisdom-style 13F tracker with Form 4
insider-transaction functionality, developed with minimal human intervention using
Claude Code (Opus model recommended for implementation phases).

## What's in this kit

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Project instructions loaded automatically by every Claude Code session |
| `ARCHITECTURE.md` | Stack decisions, data flow, schema overview, EDGAR reference |
| `PROGRESS.md` | Living status file — Claude updates it at the end of every phase |
| `PROMPTS.md` | Copy-paste prompts: kickoff per phase, resume, gate review |
| `specs/phase-0..7.md` | One spec per phase with machine-verifiable acceptance criteria |
| `.claude/settings.json` | Hooks config — auto-runs tests after every file edit |
| `scripts/hooks/run-tests.sh` | The test hook script |

## How to use it (the whole human workflow)

1. **One-time setup (~2 hours, Phase 0).** Create the accounts and secrets listed in
   `specs/phase-0-foundation.md`, copy this kit into a fresh git repo, then run the
   Phase 0 kickoff prompt from `PROMPTS.md` in Claude Code.
2. **Per phase (~15 min of your time).** Open a fresh Claude Code session in the repo,
   select the Opus model (`/model`), enable auto mode, paste the phase kickoff prompt,
   and walk away. When Claude reports done, run the gate-review prompt, skim the
   results, and merge.
3. **Repeat** through Phase 7. Phase 5 (frontend) deliberately includes an extra
   visual review checklist — budget one additional review cycle there.

## Rules that make autonomy work

- Every phase has acceptance criteria written as runnable tests. "Done" means the
  full test suite passes, not that the code looks plausible.
- Tests run against committed EDGAR fixture files — never live EDGAR — so results
  are deterministic and sessions can run offline.
- One phase per session. Fresh context per phase prevents drift; `PROGRESS.md` and
  the specs carry state between sessions, not chat history.
- Schema changes happen only through Supabase migrations (via the Supabase MCP or
  `supabase migration`), never ad-hoc SQL against a live database.

## Order of operations

Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Phase 3 (Form 4) can run in parallel with
Phase 2 if you want to speed things up — they share no tables.
