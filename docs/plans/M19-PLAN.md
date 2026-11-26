# M19 · 笔记 Markdown 与导入导出

状态：已完成并通过验收（2026-11-26）
目标：把笔记的 Markdown 预览补成「能看的 Markdown」，让快速记录能直接归类到清单 / 分组 / 标签 / 时间，
并让任务清单能在 Markdown 与 Host 数据之间双向转换（`@` 注解映射），导出可归档、导入可回填。

## 范围

| 项 | 内容 |
|---|---|
| #23 | Markdown 渲染：标题、粗体/斜体/删除线、行内代码、链接、图片、引用、分割线、有序/无序列表、任务列表、表格、代码块（含语言标注） |
| #21 | 快速记录分类面板：清单 / 分组 / 标签 / 时间（今天/明天/下周 + 具体时间），收起时不占地方，记住上次选择 |
| #20 | 任务 ⇄ Markdown：导出任务为带 `@` 注解的 Markdown；从 Markdown 列表行导入任务，注解映射回 Host 字段 |

不做：笔记的双向同步（文件系统仍是笔记唯一真相）、导入时的层级推断（缩进只影响显示，不建父子任务）、
`@` 注解之外的自定义字段、富文本所见即所得编辑。

## 关键决策

- **渲染器搬进仓库内**：`renderMarkdownPreview` 目前只存在于 `client.js` 的 v1 遗留段（build-v2 标记区间之外），
  client-v2 无法测试它。M19 把解析器放到 `src/client-shared/markdown.js`（ESM、零依赖、可单测），
  `scripts/build-v2.mjs` 以「共享前导块」方式内联（`export ` 前缀剥掉），客户端、测试、harness 同一份实现。
- **渲染只产出 VDOM，不产出 HTML 字符串**：沿用 `h()`，不做 `innerHTML`，因此不存在转义/注入面；
  图片用 `<img>` 但限制 `maxWidth:100%`，链接 `target=_blank` + `rel=noopener`。
- **`@` 注解为行尾行内注解**（用户 2026-11-26 确认）：
  ```
  - [x] 买牛奶 @list(生活) @group(采购) @due(2026-12-01) @time(19:00) @priority(P2) @tag(家务) @repeat(weekly:MO,WE) @done(2026-11-20)
  ```
  - 未完成的任务把方括号里的 `x` 去掉（即 `- [` + 空格 + `] 标题 …`）；`*` / `+` 开头的列表行同样识别，缩进忽略（不建层级）。
  - 标题 = 首个合法 `@key(值)` 之前的文本（trim）。未知 `@key(...)` 保留在标题里，并在导入报告里列出，不静默丢弃。
  - 键：`list` / `group` / `due` / `start` / `time` / `priority`（P1–P4 → high/medium/low/none）/ `tag`（可重复）/ `repeat` / `done` / `id`。
  - `group` 必须落在 `list` 下（缺 `list` 时用清单内首个、再退回收集箱）；名称找不到时按「新建」处理并在报告里说明。
- **导入是「可预演的两阶段」**：`dryRun:true` 只回报告不写库；默认写入。去重规则：同 `list + title + dueDate` 已存在则跳过并计入 `skipped`；
  带 `@id(tsk_...)` 时按 id 命中则更新（乐观并发用当前 rev）。
- **导出以「编辑后再导回」为目标**：每个任务行都带完整注解，块级标题（`## 清单名`）只是给人看的，导入时忽略；
  `[x]` 由 `completedAt` 决定，`@done` 写完成日期（本地日）。
- **快速记录面板默认收起**，展开后四项都提供「不指定」；选择立即生效但不打断输入，草稿（#15）扩为保存归类选择。

## 分阶段

1. **P19.1 Markdown 渲染（#23）**：新增 `src/client-shared/markdown.js` 解析器（块模型 + 行内模型）；
   `scripts/build-v2.mjs` 支持共享前导块；`client-v2/50-notes.js` 的预览分支改为本地渲染器；
   单测覆盖表格/任务列表/代码块/链接/图片/引用/嵌套列表。
2. **P19.2 快速记录分类面板（#21）**：`client-v2/10-shell.js` 的 `V2HostCaptureDialog` 增加分类面板；
   提交时带 `listId/groupId/tagIds/dueDate/scheduledDate+scheduledStartAt`；标签按名称即时创建；
   草稿保存归类选择；静态契约 + harness 截图验收。
3. **P19.3 任务 ⇄ Markdown（#20）**：`src/domain/task-markdown.js` 纯函数（`formatTasksMarkdown` / `parseTasksMarkdown`）；
   `task-service` 增加 `exportTasksMarkdown` / `importTasksMarkdown`；路由 `GET /markdown/tasks`、
   `POST /markdown/tasks/import`（校验器进 `routes-m6.js`）；笔记 Tab 增加「导出任务到笔记」「从当前笔记导入任务」；
   单测 + 集成测试（路由/服务）+ 截图。
4. **P19.4 验证与收尾**：`build-v2 --check`、全仓 `npm test`、harness 截图三张（渲染 / 面板 / 导入报告）、
   backlog #20/#21/#23 证据、`check --tests`、归档计划、STATUS 更新。

## 验收门禁

- [x] `node --check` 所有改动文件通过；`node scripts/build-v2.mjs --check` 无陈旧（9 modules up to date）。
- [x] 预览能正确渲染标题、粗斜体、行内代码、链接、图片、引用、分割线、有序/无序列表、任务列表、表格、代码块。
- [x] 快速记录面板可选清单/分组/标签/时间；不选时行为与现在完全一致；选择在草稿里保留。
- [x] 导出的 Markdown 每个任务行都带注解；导入同一份文件得到同样的任务字段（往返一致）。
- [x] 导入 `dryRun` 只报告不写库；重复导入同一份文件不产生重复任务。
- [x] 未知注解保留在标题中并在报告中列出；空标题行跳过并有提示。
- [x] 全仓测试全绿（基线 643 → 680）。
- [x] 截图归档，`node scripts/spec-sync.mjs check --tests` 通过，backlog 三项带证据，计划归档。

## 验收记录（2026-11-26）

- 渲染器：`src/client-shared/markdown.js`（`parseMarkdown` / `renderMarkdown` / `MAX_MARKDOWN_CHARS=200000`），
  `build-v2` 共享前导块内联为 `/* ---- shared:markdown.js ---- */`；`test/unit/client-shared/markdown.test.mjs` 15 pass。
- 分类面板：`client-v2/10-shell.js` 的 `V2Capture*`（`V2_CAPTURE_CLASSIFY_KEY`、`v2CaptureSubmitTask`、`renderClassifyPanel`）；
  harness 端到端提交断言 `POST /tasks` 收到 `{listId:'lst_life',groupId:'grp_shop',tagIds:['tag_1'],scheduledStartAt:'2026-11-27T11:00:00.000Z'}`；
  截图 `docs/images/m19-capture-panel.png`。
- 任务 ⇄ Markdown：`src/domain/task-markdown.js`（单测 9 pass）、`task-service.exportTasksMarkdown/importTasksMarkdown`、
  `GET /markdown/tasks` 与 `POST /markdown/tasks/import`（服务测试 8 pass、路由测试 3 pass）；
  笔记 Tab 菜单「导出任务到笔记 / 从当前笔记导入任务」+ 导入预览对话框；截图 `docs/images/m19-task-import-report.png`。
- 预览截图 `docs/images/m19-markdown-preview.png`（标题/引用/表格 9 格/图片/链接/代码块/任务列表/分割线）。
- 全仓 `npm test` 680 pass / 0 fail；`build-v2 --check` up to date；harness 残留进程与临时目录均为 0。
