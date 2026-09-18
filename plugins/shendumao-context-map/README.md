# 神都猫脉络 · Codex 插件

神都猫脉络把长期对话或已有规划整理成可回溯的思路地图。当前 0.2 阶段完成了本机持久化、不可变版本历史、增量更新和图内轻量编辑；它不依赖 `127.0.0.1`，由 Codex 以 stdio 启动本地 MCP 服务，并直接加载插件内打包的 HTML 界面。

插件包包含：

- `.codex-plugin/plugin.json`：插件身份、展示信息和能力声明。
- `.mcp.json`：本地 MCP 服务启动配置。
- `mcp/server.bundle.mjs`：无需安装运行时 npm 依赖的单文件服务包。
- `assets/context-map-widget.html`：自包含的 MCP Apps 交互界面。
- `skills/visualize-context/SKILL.md`：指导 Codex 保真整理对话、区分证据类型并调用地图工具。

## 0.2 阶段能力

- 首次整理时创建一张持久地图；后续对话可通过语义操作继续增加、修改、移动或删除主题和节点。
- 每次写入生成一个完整、不可变的 revision JSON。节点在新版本中删除后，旧版本仍可读取，不会被物理覆盖。
- 写入使用 `expectedRevision` 做乐观并发控制，并用必填的 `mutationId` 与请求哈希保证安全重试，避免重复保存或静默覆盖较新的修改。同一次逻辑请求的重试必须复用原 `mutationId`，新的修改必须使用新值。
- revision 可保存本次修改原因 `change` 和来源检查点 `sourceCheckpoint`，用于回想“当时为什么这样改”和整理到了哪个位置。
- 界面支持纵向/横向自动排版、平移缩放、全图适配、展开显示、四种主题、菜单中英文切换、节点详情和 JSON 导出。语言切换只影响菜单，不改写对话内容。
- 已保存地图可在界面中选择节点后添加后续节点；双击可编辑；右键可编辑、在后面添加或删除。每次操作都会保存为新 revision；并发冲突时会载入最新版并提示重新修改。内置演示图只读。

当前图内编辑是轻量编辑：节点自由坐标拖动、拖动换层级和完整脑图导入尚未接入；横纵方向仍由智能排版重新计算。

## 六个 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `prepare_context_map` | 校验、规范化并持久保存首版地图，返回 `mapId` 与 `revision`。 |
| `update_context_map` | 在指定 `expectedRevision` 上原子应用增量操作，保存为下一版本；支持地图、主题和节点的增删改移。 |
| `get_context_map` | 按 `mapId` 读取完整地图；可指定 `revision` 回看历史，省略时读取最新版。 |
| `list_context_maps` | 按最近更新时间列出本机已保存地图的摘要，不返回完整节点正文。 |
| `list_context_map_revisions` | 列出一张地图的版本号、更新时间与修改原因。 |
| `render_context_map` | 在交互画布中打开最新版或指定历史版本；省略 `mapId` 时打开只读演示。 |

`prepare_context_map` 与 `render_context_map` 默认只把标题、起点、版本号和统计放进模型可见的 `structuredContent`；完整地图在渲染时通过 `_meta.widgetData` 交给界面。需要 Codex 重新读取全部结构时，应显式调用 `get_context_map`。

节点可通过 `related` 指向另一个前置节点，界面会用虚线绘制跨主题关联或汇合边。节点还可记录 `evidence` 与 `sourceRefs`，用于区分用户原话、助手报告、归纳和待验证推断。

## 持久化位置

数据目录按以下优先级解析：

1. 环境变量 `SHENDUMAO_DATA_DIR` 指定的目录。
2. `$CODEX_HOME/shendumao-context-map`。
3. 操作系统的用户数据目录：
   - Windows：`%LOCALAPPDATA%\Shendumao\ContextMap`，没有时依次回退到 `%APPDATA%` 和用户目录下的 `AppData\Local`。
   - macOS：`~/Library/Application Support/Shendumao/ContextMap`。
   - Linux：`$XDG_DATA_HOME/shendumao-context-map`，没有时使用 `~/.local/share/shendumao-context-map`。

每张地图位于 `maps/map-<UUID>/`，版本文件形如 `revision-00000001.json`。写入采用每图跨进程锁、同目录临时文件、文件同步和原子重命名；崩溃遗留的陈旧锁会在复核锁身份后恢复。

插件更新只替换插件代码，不会删除上述独立数据目录。若需要备份或迁移，可在 Codex 未写入时复制整个数据目录；界面导出的单图 JSON 使用 `format: "shendumao-context-map"`、`schemaVersion: 1`。

## 安装与更新

插件通过 Codex marketplace 安装。Windows 与 macOS 均需先安装 Codex 和可从终端运行的 Node.js 18+。仓库内已有打包好的 `mcp/server.bundle.mjs`，普通安装不需要 `npm install`。添加 GitHub 仓库并安装：

```powershell
codex plugin marketplace add signerzwb/shendumao-codex-context-map
codex plugin marketplace list
codex plugin add shendumao-context-map@shendumao
```

本地 marketplace 也可以直接传目录：

```powershell
codex plugin marketplace add C:\path\to\marketplace
codex plugin add shendumao-context-map@shendumao
```

Git marketplace 发布新版本后，刷新并重新安装插件：

```powershell
codex plugin marketplace upgrade shendumao
codex plugin add shendumao-context-map@shendumao
```

发布方需要同步更新 marketplace 条目中的版本或 cachebuster，Codex 才会生成新的安装缓存。安装或更新后新建一个 Codex 任务；已经运行的任务不会热加载刚替换的 MCP 服务与技能。

## 本地开发验证

```powershell
npm ci
npm run build
npm test
```

`npm run build` 会把服务及依赖打包进 `mcp/server.bundle.mjs`。最终运行仍需要系统或 Codex 运行环境能够执行 `node`，但不需要启动网页服务器。

## 能力边界

普通 MCP 服务只能看到 Codex 明确传给工具的参数，不能自行访问 Codex 当前任务、历史任务数据库，也不能在后台监听每一轮对话。因此：

- 在当前任务中，Codex 可以根据模型当前可见的上下文整理地图，再显式调用 `prepare_context_map` 或 `update_context_map`；这不是 MCP 服务主动读取对话。
- 整理历史任务时，需要用户打开或指定任务，并由宿主提供且授权相应的任务读取能力，或由用户提供导出的内容。仅安装本插件不会自动获得历史任务权限。
- “自然生长”当前表示在合适的对话节点让 Codex 显式执行增量更新，不代表安装后会无感监听所有任务。
- 未来可以把 Codex 生命周期 Hooks 做成可选、需用户开启的自动检查点入口；Hooks 不属于 0.2，也不应被当作默认权限或既有能力。

所有持久化都发生在本机。是否把任务内容交给模型整理，仍遵循 Codex 宿主本身的模型、权限与数据设置。

交流与反馈：QQ 群 **340983417**。报告问题时请勿公开私人对话或凭据。
