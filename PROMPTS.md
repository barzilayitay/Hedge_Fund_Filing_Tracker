# PROMPTS.md — Copy-paste prompts for Claude Code (Opus)

Session hygiene: one phase per session, fresh session per phase. In each
session: `/model` → select Opus, enable auto mode, then paste the prompt.
State lives in the repo (`PROGRESS.md`, specs), not in chat history — that's
what makes "continue later" work.

---

## Phase kickoff (universal template)

Use for any phase; replace N.

```
You are implementing Phase N of this project.

1. Read PROGRESS.md, CLAUDE.md, ARCHITECTURE.md, and specs/phase-N-*.md in
   full before writing any code.
2. Write a step-by-step plan derived from the spec's Deliverables section and
   show it to me briefly, then proceed without waiting.
3. Work test-first: implement the spec's acceptance criteria as tests before
   or alongside the code they verify. The PostToolUse hook runs the suite
   after every edit — fix failures immediately.
4. The phase is complete only when every acceptance criterion in the spec
   passes, plus typecheck, lint, and the full test suite.
5. Finish by updating PROGRESS.md (status, what was built, decisions made on
   ambiguities, open questions for my review) and committing on a branch
   named phase-N, then open a PR.
6. Do not start any other phase. Do not touch production. If you hit a
   destructive or irreversible ambiguity, stop and ask; otherwise decide,
   record it, and continue.

Begin.
```

---

## Phase 0 kickoff (use this exact one for the first session)

```
You are implementing Phase 0 of this project. Read CLAUDE.md,
ARCHITECTURE.md, and specs/phase-0-foundation.md in full first.

I have completed the human prerequisites checklist in the spec: the Supabase
dev project exists and the Supabase MCP is connected; .env will be filled by
me from the .env.example you generate.

Scaffold everything in the spec's Deliverables list. Two notes:
- The fixtures script needs live EDGAR access — run it once now, verify the
  downloaded fixtures are valid XML, and commit them. All future test runs
  must use only these committed files.
- Prove the hook works: after setup, make a trivial failing test, watch the
  PostToolUse hook surface it, fix it, and mention this verification in
  PROGRESS.md.

Finish per the workflow in CLAUDE.md: acceptance criteria green, PROGRESS.md
updated, commit on branch phase-0, open a PR. Begin.
```

---

## Resume an interrupted phase

```
You are resuming Phase N. Read PROGRESS.md, specs/phase-N-*.md, and run
`git status` + `npm run test` to establish current state before doing
anything else. Compare test results against the spec's acceptance criteria,
list what remains, and complete the phase per CLAUDE.md workflow. Do not
redo work that already passes.
```

---

## Gate review (run this yourself at each phase gate, ~15 min)

```
Act as an independent reviewer of Phase N — assume the implementer was a
different agent and be adversarial. Read specs/phase-N-*.md, then:

1. Run the full suite (test, typecheck, lint; e2e if this phase has it) and
   report raw results.
2. For each acceptance criterion in the spec, cite the specific test that
   proves it, or flag it as unproven.
3. Check the hard rules in CLAUDE.md: grep for direct sec.gov calls in
   tests, DDL outside migrations, secrets in the diff, non-idempotent
   inserts in loaders.
4. Read PROGRESS.md "Decisions" and tell me whether any recorded decision
   deviates from the spec in a way I should overrule.
5. Verdict: MERGE, or a numbered fix list.

Do not fix anything in this session — review only.
```

If the verdict is a fix list, start a fresh session:

```
Phase N gate review produced this fix list: [paste]. Read the spec and
PROGRESS.md, fix each item, keep all tests green, update PROGRESS.md, and
push to the phase-N branch.
```

---

## Phase 5 addendum (frontend visual pass)

After the standard kickoff completes and e2e is green, run once:

```
Phase 5 visual pass. Start the dev server with seeded data. Take Playwright
screenshots of: fund summary tab, holdings table (25 rows), stock insiders
tab, confluence chart, and the fund page at 390px width. Save to
/screenshots and list the paths. Then self-review each against the Design
constraints section of specs/phase-5-frontend.md and fix what fails
(overflow, unformatted numbers, "null" strings, unreadable badges).
Re-screenshot after fixes.
```

Then look at the screenshots yourself — this is the one gate where your
eyes beat the tests.

---

## Emergency / drift check (any time behavior seems off)

```
Stop current work. Summarize: what phase you're in, what the spec requires,
what you've changed in this session (git diff --stat), and whether anything
you've done conflicts with CLAUDE.md hard rules or the spec. Do not write
code until I respond.
```
