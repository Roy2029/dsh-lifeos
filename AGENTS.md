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

## Git flow（2026-11-27 事故复盘后固化）

> 背景：2026-11-27 我在「把当前版本合并到 GitHub」时直接 `git push origin main`，
> 快进推送了 12 个提交，绕过分支隔离与评审。`main` 是发布口径，任何人（包括 Agent）
> 都不得直接推送，下面的流程是硬约束。

1. **永远从最新 `main` 切功能分支**：`git switch main && git pull --ff-only`，
   然后 `git switch -c <type>/<short-scope>`（`feat/` `fix/` `docs/` `chore/`）。
2. **只在功能分支上提交与推送**：`git push -u origin <branch>`；`main` 保持不动。
3. **用 PR 收口**：`gh pr create --base main --head <branch>`；PR 正文写清改动、
   验收证据（`npm test` 结果、`node scripts/spec-sync.mjs check --tests`、
   截图路径、计划/backlog 链接）与风险。
4. **等待评审**：不自行合并；需要改动就继续在同一分支补提交。CI 与评审意见都通过后，
   由仓库主理人合并（squash 或 merge 按其选择）。
5. **合并后同步**：`git switch main && git pull --ff-only`，删除已合并的本地/远端分支。
6. **禁止项**：禁止 `git push origin main`、禁止 `git push --force` 到共享分支、
   禁止跳过 PR 直接改远端默认分支。远端已分叉时先报告，不自行决定策略。
7. **例外**：仅当用户在当前对话中明确要求「直接推 main」时才可以直推，
   并在最终回复里注明这是用户授权的一次性例外。

## Commit 约定

- 一个提交只做一件事：功能 / 测试 / 文档收尾分开，便于 review 和回滚。
- 提交信息用中文短句概括意图，必要时在正文补「为什么」。
- 代码与文档（STATUS/backlog/计划）同批提交；`sync --tests` 与归档各自单独提交。

