# M6-PLAN · 前端交互重构（全局外壳 + 任务/日历/习惯/笔记四 Tab）

状态：**v1.0 已完成（2026-11-18 验收；M6a–M6f 全部通过，M6 之后另有 M7/M8/M9 三轮用户验收增量，见 §6）**

> 开工背景：用户要求照 `design/demo/ux-spec-v1-demo.html` 实现，已开发的 LifeOS 资产可复用，目标实现以四份新规格为准；Agent 部分下一阶段。

参考：
- 交互规格：全局 / 任务与日历 / 习惯与笔记 / Agent 四份设计文档（项目内设计资料，未随仓库发布）
- 交互 Demo：`ux-spec-v1-demo.html`（项目内设计资料，未随仓库发布）
- 现有实现：`client.js`（React lazy-CJS，7 tab 旧 UI）、Host 服务 v0.7

## 0. 结论与原则

- 这是 UI 交互范式重构，不是样式微调；Host 业务服务与数据层**复用**，UI 按新规格重写。
- 保留旧 UI：新增 `LifeosPanelV2`，用 `app_setting.ui_prefs.uiVersion`（默认 `v2`）切换；旧 `LifeosPanel` 保留为回退，验收后删除开关。
- 四 Tab：任务（清单/分组/列表+看板/详情三栏）、日历（日历+任务栏两栏，月/周/日）、习惯（列表+详情两栏）、笔记（文件树+编辑器两栏）；无项目/回顾 tab（旧入口移除或移入后续阶段）。
- 不做 Agent 浮窗（下一阶段），只留全局按钮占位；快速收集要保留（收集箱任务/随记）。
- 所有数据走现有 Host API；缺口按 §2 补齐；客户端不直接读写 storage。
- 开发期用 headless Chrome 截图 + `node --check` 做视觉/语法自检；集成后用 DSH 重启验收。

## 1. 数据/API 缺口（M6a，Host 侧）

现有：task（list_id/parent_task_id/sort_order/priority…）、list（seed 收件箱，无 API）、tag/entity_tag、habit/habit_checkin、notes 文件服务、calendar?month。

需要新增：
1. schema v2（CORE）：
   - 新表 `group`（prefix `grp`）：`list_id`(required)、`name`(required)、`sort_order`、`collapsed`。
   - `task` 增加字段：`group_id`(string)、`pinned`(boolean, default false)。
   - 迁移：UNIT_VERSION 1→2，compatibleVersions [1,2]；打开 v1 文件时自动创建缺失表/补全局；迁移前备份 `lifeos.json`（保留 5 份，`lifeos.json.bak-m6-*`）。必须先做 spike 验证 JSON 后端兼容 + 回滚路径。
2. Lists：`GET /lists`（含任务计数）、`POST /lists`、`PATCH /lists/:id`（名称/颜色/icon/排序）、`DELETE /lists/:id`（`?moveTo=` 指定任务去处；默认收集箱=无 list）、`POST /lists/reorder`。
3. Groups：`GET /lists/:id/groups`、`POST /lists/:id/groups`、`PATCH /groups/:id`（改名/折叠）、`DELETE /groups/:id`（`?moveTo=`）、`POST /groups/reorder`。
4. Task 补充：
   - `POST /tasks`/`PATCH /tasks/:id` 支持 `listId`、`groupId`、`parentTaskId`、`pinned`、`sortOrder`；
   - `POST /tasks/:id/move`（listId/groupId/parentTaskId，含层级校验≤3 层、防环、子任务随父）；`POST /tasks/:id/duplicate`；`POST /tasks/:id/restore`；`DELETE /tasks/:id?purge=1`；
   - 查询：`GET /tasks?view=today|next7|inbox|all|done|trash&listId=&groupId=&q=&from=&to=&limit=&cursor=`；返回 items + counts + groups + lists；`GET /tasks/:id` 返回 task+children+path；
   - trash：`status` 不变，`deleted_at` 软删；`view=trash` 返回已删；恢复清 deleted_at。
5. 日历：`GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` 返回区间内按日期分组的 timed/all-day 任务（替代仅 month）；保留旧 month 兼容。
6. 笔记标签：V1 用 `app_setting['notes.tags']` JSON（path→tags[]），端点 `GET/PUT /notes/tags`、批量 `POST /notes/tags/batch`（不改文件内容/路径）；后续可迁 sidecar。

所有端点：统一信封 `{ok,value}`、CAS（rev/If-Match）、SSE changed、审计 operation_log、错误码沿用。

## 2. 客户端 v2 架构（M6b 起）

在 `client.js` 内新增（保留旧代码）：
- 共享层：`v2State`（ui 状态：tab/宽度/折叠/筛选/选中，persist `/ui-prefs`）、`useV2Data`（tasks/lists/groups/calendar/habits/notes 拉取 + SSE 刷新 + 乐观更新）、`v2Api`（复用现有 apiRequest）、`v2Toasts`。
- 组件：`LifeosPanelV2`（顶栏 4 tab + 内容 + 全局浮层）、`TaskTabV2`（三栏）、`CalendarTabV2`（两栏）、`HabitTabV2`（两栏）、`NotesTabV2`（两栏）、`QuickCaptureV2`、`TaskDetailPanelV2` 等。
- 样式：全部 `--dsw-alias-*` token + 内联 style；分栏宽度/收起持久化到 ui_prefs；断点 1440/1024。
- 复用：`m4Body`、`apiRequest`、`loadBootstrap`、SSE `startEvents`、toast、`openMenu`/`openModal` 等价物；笔记复用现有 notes API 客户端。

## 3. 分期与门禁

- M6a Host 数据/API（本阶段最先做）：schema v2 迁移 + lists/groups/task extras/calendar range/notes tags；单测 + 迁移回滚测试；M6a-G1..G4 全绿。
- M6b 外壳 + 任务 Tab：顶栏、四 tab 路由、三栏布局、清单/分组/过滤器/完成/删除/垃圾桶/拖拽/详情/Inline 创建编辑/看板；M6b-G1..G6。
- M6c 日历 Tab：月/周/日、时间网格、创建/改期/改时长/拖拽、任务栏；M6c-G1..G5。
- M6d 习惯 Tab：7 天条、打卡/撤销、统计卡、月历、日志、编辑；M6d-G1..G5。
- M6e 笔记 Tab：树/快捷分组/新建命名/拖拽/多选/标签/自动保存/冲突；M6e-G1..G6。
- M6f 整合：uiVersion 切换、旧 UI 回退、自检 `runM6SelfCheck`、全仓测试、DSH 重启验收；M6f-G1..G4。

## 4. 所有权

- Lead：架构、client.js 外壳/任务 Tab、整合、门禁与验收。
- a-host（teammate）：schema v2 + API + 测试 + 迁移验证；只写 `src/domain/`、`src/store/`、`src/application/`、`src/runtime/`、`test/`。
- b-client（teammate）：日历/习惯/笔记 Tab 组件（在 client.js 内的独立函数区，按 Lead 约定接口）；只写自己的区块 + 测试截图脚本。
- c-qa（teammate）：headless 截图/交互回归脚本、M6 自检、跨 tab 回归；可写 `test-artifacts/m6-verify/`、`scripts/`。

## 5. 风险

- schema v2 迁移破坏存量数据 → 备份 + 兼容版本 + 回滚测试；先 spike。
- client.js 单文件膨胀 → 新代码分区注释 + 后续构建拆分（S1 spike 不阻塞本次）。
- 旧自检（M1–M4）针对旧 UI → M6 自检替代；旧自检仅在 uiVersion=legacy 时运行。
- DSH 重启才能加载新 client → 每阶段结束请用户重启一次验收。
- 四 tab 交互多，分阶段提交，每阶段可独立验收。

## 6. 完成记录（v1.0）

- **M6a–M6f 全部完成并验收**：2026-11-18 13:14 完全重启（pid 13956）后自动 `m6-selfcheck` 返回 `m6.ok=true`（7/7 steps，四 Tab contentBlocks 153/162/240/215、`errorVisible:false`），Host 12 门全 true、589/589 测试；`clientSelfCheck` 已改回 false。详细证据见 `design/20-M6开发验证报告.md` 与 `test-artifacts/m6-verify/`。
- 最终构建：`client.js` 1,016,050B（M6 验收时）；当前（M9 后）1,100,069B；全仓测试 612/612。
- **M7 增量（验收后第一轮用户反馈）**：日历任务栏清单统一 `/lists`；月格拖放不再 422；组内拖拽排序；任务多选批量（移入清单/加标签/删除）；标签系统（侧栏标签区、行 chips、详情编辑、新建、批量加标签）；分组编辑（重命名/移清单/删除回未分组）；笔记 Ctrl/Shift 多选；UI 去重加号与图标移位。
- **M8 增量（第二轮）**：schema v3 + 任务重复属性（每天/每周/每月，完成后自动生成下一实例）；标签编辑/删除 Host API + 标签弹窗；任务/日历/习惯/笔记分栏可拖拽与收起（宽度持久化）；计数口径统一；空分组显示；分组迁移删旧组；拖拽排序 409 修复；笔记编辑器尺寸；收件箱清单清理策略。
- **M9 增量（第三轮）**：默认收件箱清单可删除（任务回收集箱，空清单自动清理）；笔记编辑器高度链修复（撑满高度、底部状态栏贴底）；V2 模式隐藏侧栏未读红点。
- 复盘与经验沉淀：`design/21-M6阶段回顾与经验沉淀.md`。
