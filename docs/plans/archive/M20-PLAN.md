# M20 · 一致性收尾（partial 清理）

状态：已归档（2026-11-27）
目标：把 backlog 里 6 条 `partial` 记录逐条补到可用状态——快速记录的边界反馈、页签状态记忆、
共享日期选择器覆盖到日历与习惯弹窗、列表栏宽度上限、草稿展开态、日历任务栏排序与弹窗字段。
`deferred`（#11 重复任务提示、#24 逾期语义）按用户 2026-11-27 指示保持不动。

## 范围

| 项 | 当前缺口 | M20 补法 |
|---|---|---|
| #3 | 只有 1.6s 高亮提示；无超限反馈、无 3s 气泡、文本域不自增高 | Enter 长文反馈改为 3 秒气泡；超过上限时抖动 + 气泡 + 禁止提交；文本域按内容自增高（96–240px） |
| #4 | 日历只存 view/anchor，未存选中任务 | 日历状态增加 `selectedTaskId` + 弹窗打开态；切换页签回来重新打开该任务详情（任务已删除则忽略） |
| #8 | 日历任务弹窗、习惯编辑弹窗仍用原生 `input[type=date]` | 两处改用共享 `V2DatePicker`（时间输入仍保留原生 `time`，因为需要分钟精度且无共享组件） |
| #14 | 列表栏固定 420–1000，不是 50% 上限 | 拖拽与读取都改为「不超过三栏容器宽度的 50%」，窗口变化时收敛 |
| #15 | 文本/目标已存，展开态未存 | 分类面板展开态随草稿持久化（`classify.open`），并补测试固定该行为 |
| #18 | 任务栏缺 标题/标签/修改时间 排序；弹窗缺 截止日期 与 分组 | 增加三种排序；弹窗补 截止日期（V2DatePicker）与分组选择（按清单联动） |

不做：日历弹窗改造成任务详情全屏面板（保留紧凑弹窗，只补字段）；重复任务提示与逾期语义（deferred）。

## 关键决策

- **上限值与 Host 一致**：快速记录文本上限取 `MAX_CAPTURE_CHARS = 20000`（`src/client-shared/contract.js`），
  客户端在 90% 处显示计数，超限时抖动 + 3 秒气泡并阻止提交，不再让 Host 409 变成事后错误。
- **气泡而非常驻文案**：长文按 Enter 与超限共用同一个 3 秒气泡区（`role="status"`），不挤占底部说明行。
- **自增高只改行高**：`textarea` 用 `scrollHeight` 夹在 96–240px；实测高度存进 `textHeight` state，
  重渲染后仍保持（只写 DOM style 在整树重建时会丢高度）。
- **页面状态只存 id 不存整对象**：日历存 `selectedTaskId`，恢复时按当前任务集查找；任务页签已存完整快照（M15）。
- **宽度上限用容器实测**：`beginPaneDrag` 时读分隔条父容器的 `getBoundingClientRect().width`，
  `max = max(min, floor(width / 2))`；渲染时再用同一规则夹一次，窗口缩小后自动收敛。
- **排序比较器复用任务页签语义**：标题用 `localeCompare('zh-CN')`，标签按首个标签名再按标题，
  修改时间用 `updatedAt/updated_at` 倒序，缺失值排后。

## 分阶段

1. **P20.1 快速记录边界（#3/#15）**：`client-v2/10-shell.js` 增加 `V2_CAPTURE_MAX_CHARS`、
   `v2CaptureTextTooLong`、抖动动画状态、3 秒气泡、文本域自增高；草稿持久化断言展开态。
2. **P20.2 页签状态与宽度（#4/#14）**：`client-v2/30-calendar.js` 状态加 `selectedTaskId`；
   `client-v2/20-tasks.js` 列表栏宽度上限改 50%，渲染时夹紧。
3. **P20.3 共享日期选择器（#8）**：`30-calendar.js` 任务弹窗日期、`40-habits.js` 习惯编辑器开始日期改用 `V2DatePicker`。
4. **P20.4 日历任务栏（#18）**：`CAL2_BAR_SORT_DEFS` 增加 `title` / `tag` / `modified` + 比较器；
   弹窗补 `due`（V2DatePicker）与 `groupId`（随清单联动，提交带 `groupId`）。
5. **P20.5 验证收尾**：单测（排序比较器、上限判定、宽度夹紧）+ 静态契约断言 + harness 截图（快速记录气泡/日历弹窗/排序菜单）；
   `build-v2 --check`、全仓 `npm test`、backlog 六项证据、`check --tests`、归档、STATUS。

## 验收门禁

- [x] 快速记录：超过上限时抖动 + 气泡并拒绝提交；长文 Enter 有 3 秒气泡；文本域随内容长高（96–240px）。
- [x] 快速记录：关闭再打开，文本/目标/分类面板展开态都恢复。
- [x] 日历：切换到别的页签再回来，之前打开的任务弹窗重新打开；任务不存在时静默忽略。
- [x] 日历任务弹窗与习惯编辑器的日期选择器都是共享组件（无 `input[type=date]`）。
- [x] 列表栏拖拽到超过容器 50% 时停在上限；窗口缩小时已保存宽度收敛到 50%。
- [x] 任务栏支持 标题/标签/修改时间 排序且顺序符合预期；弹窗可设截止日期与分组。
- [x] 全仓测试全绿（基线 680 + 新增），`node scripts/build-v2.mjs --check` 无陈旧。
- [x] 截图归档、`check --tests` 通过、backlog 六项带证据、计划归档。

## 验收记录（2026-11-27）

- **#3 快速记录边界**：`client-v2/10-shell.js` 加 `V2_CAPTURE_MAX_CHARS=20000`、`v2CaptureTextTooLong`、
  `v2CaptureLimitMessage`、3 秒气泡（`role="status"`）、抖动（`translateX` 衰减）、`autoGrowTextarea`（96–240px）。
  harness 结果：`GROW 240`、`COUNTER true`（`已用 20001 / 20000 字`）、
  `NOTICE ["超过 20000 字上限，请拆成多条，或先存为随记"]`，截图 `docs/images/m20-capture-limit.png`。
- **#15 展开态记忆**：`classify.open` 随草稿（`v2ReadCaptureDraft` / `V2_CAPTURE_CLASSIFY_KEY`）持久化；
  静态契约断言 `open: source.open === true`。
- **#4 日历恢复**：`cal2ReadPrefs/cal2WritePrefs` 增加 `selectedTaskId`（只存 id），恢复在 `loadData` 里按当前任务集查找，
  `restorePendingRef` 防止首屏用空值覆盖；harness 刷新后 `PREFS {"selectedTaskId":"tsk_4"}` → `RESTORED` 命中弹窗。
- **#8 日期选择器统一**：`30-calendar.js` 任务弹窗日期与 `40-habits.js` 习惯开始日期改用 `V2DatePicker`；
  静态契约断言四个 client 模块都不含 `type: 'date'`。
- **#14 宽度上限**：`paneContainerWidth/paneMaxWidth` 取容器实测一半（`Math.floor(measured / 2)`），
  `clampPanesToContainer` 在挂载与 resize 时收敛并写回；harness 预置 `main: 1000` →
  `PANE {"storedMain":720,"widths":[300,6,720,6]}`，截图 `docs/images/m20-task-pane-width.png`。
- **#18 任务栏排序与弹窗字段**：`CAL2_BAR_SORT_DEFS` 扩到 7 项（日期/优先级/标题/标签/修改时间/创建时间/自定义），
  新增 `barCompareByTitle/barCompareByTag/barCompareByModified`；弹窗补 `dueDate`（V2DatePicker）与 `groupId`（随清单联动、切换清单清空）。
  harness：`SORTS {"count":7,...}`、`MODAL {"hasDueTitle":true,"hasDuePicker":true,"groupOptions":["不分组","项目计划","日常","工作"]}`，
  截图 `docs/images/m20-calendar-task-modal.png`。
- **顺带修掉的真实缺陷**：`validateCreateTask/validateUpdateTask` 现在接受 `listId`/`groupId`（此前快速记录带分类会被 422 拒绝，
  而服务层早已支持）；契约与路由测试各补一例。
- **验证**：`node scripts/build-v2.mjs --check` 无陈旧；全仓 `npm test` = 683 pass / 0 fail；
  `node scripts/spec-sync.mjs check --tests` 通过。
