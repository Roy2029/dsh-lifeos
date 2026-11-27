# Product backlog

> One row per user-visible item. Status: todo | in-progress | partial | done | deferred | external | dropped.
> `done` rows require evidence (commit, test, screenshot, or doc path).
> `partial` rows require a note describing what remains.

Source: 2026-11-24 product feedback (32 items). Decisions are reflected in the
Status/Milestone columns and in `docs/plans/archive/M20-PLAN.md`; this table is the
repository's only tracking copy.

| ID | Item | Status | Milestone | Evidence |
|---|---|---|---|---|
| #1 | Inline titles: group rename, habit title, habit icon | done | M18 | M18: habit icon picker (recent 8 + 80 emoji matrix, habit.icon) and inline habit title rename; docs/images/m18-habits-icon-picker.png; static + harness checks |
| #2 | Multi-select highlight must equal selection; batch move to group | done | M15 | 6e70593 |
| #3 | Quick capture: Enter hint, over-limit feedback, rule tooltip | done | M20 | M20: shake + 3s bubble + auto-grow (96-240px) + 20000-char cap; docs/images/m20-capture-limit.png |
| #4 | Remember per-tab page state (scope, selection, detail, scroll) | done | M20 | M20: calendar stores selectedTaskId and reopens the dialog after reload |
| #5 | Trash batch restore / permanent delete; remove invalid actions | done | M15 | 6e70593 |
| #6 | Per-list completed display mode | done | M17 | 563fc2f; 3 modes after done-list removal (inline / group-bottom / hidden) |
| #7 | Keep focus and position when creating tasks inside a group | done | M15 | 6e70593 |
| #8 | Shared modern date picker across task/calendar/settings | done | M20 | M20: calendar task dialog + habit editor use V2DatePicker (no input[type=date] left) |
| #9 | Inline edit: click positions cursor instead of select-all | done | M15 | 6e70593 |
| #10 | More themes (light, black, hue themes, token cleanup) | external | — | delegated to another team; not in local milestones |
| #11 | Repeat task completion hint (next cycle date) | deferred | — | awaiting research; excluded from M16 |
| #12 | Auto-fill start date for repeat tasks without a date | done | M16 | f0bf2f8 |
| #13 | Move search entry to the task list bar, keep `/` shortcut | done | M15 | 6e70593; searches current scope only |
| #14 | Capsule list width max 50% of three-pane layout | done | M20 | M20: max = half of measured pane container, clamped on mount/resize; docs/images/m20-task-pane-width.png |
| #15 | Quick capture draft persistence | done | M20 | M20: classify panel open state persists with the draft |
| #16 | Habit groups (habit_group + group_id, CRUD, drag, collapse, schema v4) | done | M18 | M18: schema v4 + habit-groups API/UI; docs/plans/archive/M18-PLAN.md; docs/images/m18-habits-groups.png, m18-habits-collapsed.png |
| #17 | Distinguish multi-select checkbox from complete checkbox | done | M15 | 6e70593 |
| #18 | Calendar task properties use full task detail; task bar grouping/sorting | done | M20 | M20: 7 bar sorts incl. title/tag/modified; dialog adds due date + group; docs/images/m20-calendar-task-modal.png |
| #19 | Quick time options (today / tomorrow / next week) | done | M16 | f0bf2f8 |
| #20 | Markdown import/export with `@` annotation mapping | done | M19 | M19: task ⇄ Markdown round trip with dryRun preview; docs/plans/archive/M19-PLAN.md; docs/images/m19-task-import-report.png |
| #21 | Quick capture category panel (list/group/tag/time) | done | M19 | M19: capture panel + draft persistence; docs/images/m19-capture-panel.png |
| #22 | New daily note must not report external modification | done | M15 | 6e70593 |
| #23 | Markdown rendering: links, images, tables, task lists, code blocks | done | M19 | M19: shared parser src/client-shared/markdown.js; docs/images/m19-markdown-preview.png |
| #24 | Overdue semantics (cancel / postpone / stats) | deferred | — | awaiting research |
| #25 | Note path_exists check, dedupe tree, single toast | done | M15 | 6e70593 |
| #26 | Five UI font sizes | done | M15 | 6e70593 |
| #27 | Collapsible list-bar sections | done | M15 | 6e70593 |
| #28 | Clarify the “N 聚焦” hint | done | M15 | 6e70593 |
| #29 | Task detail notes save | done | M15 | 6e70593 |
| #30 | Cross-day tasks rendered across columns | done | M16 | f0bf2f8 + 563fc2f; timed cross-day segment drag still unsupported |
| #31 | Drag-select visual selection + bubble input | done | M17 | f0bf2f8 + 563fc2f |
| #32 | Calendar global date picker | done | M16 | f0bf2f8 |
