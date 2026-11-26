# AGENTS.md

<!-- spec-sync:begin -->
## Project state and docs (managed by spec-sync)

- `STATUS.md` is the single source of truth for version, milestone, phase, test
  count, and last verified commit.
- `docs/product/backlog.md` is the only place for item status and evidence.
- Before work, run `node scripts/spec-sync.mjs status`.
- After work, update `STATUS.md` and the backlog, then run
  `node scripts/spec-sync.mjs check --tests`.
- Do not put volatile numbers in `README.md`; link to `STATUS.md`.
- Finished plans move to `docs/plans/archive/`; never delete them.
<!-- spec-sync:end -->
