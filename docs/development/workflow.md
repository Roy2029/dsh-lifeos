# Development workflow

This file is the contract between code, docs, and status. It is intentionally
short; the executable rules live in `scripts/spec-sync.mjs`.

## Single sources of truth

| Question | File |
|---|---|
| What are we building now? | `STATUS.md` |
| What is left, and what proves it shipped? | `docs/product/backlog.md` |
| What did we agree to build? | `docs/plans/*.md` and `openspec/specs` |
| How do I use the product? | `README.md` (stable; no volatile numbers) |

## Lifecycle

### 1. Start

- Run `node scripts/spec-sync.mjs status`.
- Pick one backlog item or one milestone plan. Do not work on several unrelated
  items at once.
- If the item changes behavior, write the acceptance criteria first (plan or
  OpenSpec change).

### 2. Work

- Keep commits small and scoped to one item.
- Update the plan's checkboxes only after the corresponding evidence exists.
- Do not edit `STATUS.md` mid-work unless the milestone changes.

### 3. Finish

- Run the real test command and `node scripts/spec-sync.mjs check --tests`.
- Add evidence to the backlog row: commit, test name/output, screenshot path, or
  doc path.
- Update `STATUS.md`: milestone, phase, test count, date, commit.
- Archive the milestone plan only after user-visible verification.

### 4. Archive

- Move finished plans to `docs/plans/archive/` with
  `node scripts/spec-sync.mjs archive-plan docs/plans/Mx-PLAN.md`.
- Archive OpenSpec changes with `openspec archive <name>` after validation.
- Keep history; never delete a plan.

## Definition of done

- [ ] The user-visible behavior works, not just the code path.
- [ ] Tests pass with the documented command; the count is in `STATUS.md`.
- [ ] Backlog row has evidence and the correct status.
- [ ] Plan checkboxes match reality; no "in progress" plan with everything done.
- [ ] `node scripts/spec-sync.mjs check --tests` passes.
- [ ] README still describes the product, not the current sprint.

## Status vocabulary

- `todo`: not started.
- `in-progress`: actively being built.
- `partial`: some user-visible part shipped; evidence says what remains.
- `done`: verified; evidence is required.
- `deferred`: intentionally postponed; record why.
- `external`: owned by another team/branch.
- `dropped`: no longer planned; record why.

## Guardrails

- Never mark a checkbox from a plan or a test you did not actually run.
- Never put changing numbers (test counts, version, current milestone) in
  `README.md`; link to `STATUS.md` instead.
- Plans live in the repository, not in a chat or an external folder.
- When code and docs disagree, treat the code as evidence and the doc as a bug.
