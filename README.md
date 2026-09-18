# 神都猫脉络（Shendumao Context Map）

把长期 Codex 对话中的初心、主题分支、转折、决定理由和待办事项整理成一张可回看的思路地图。地图保存在本机，可以在后续任务中增量更新、手工编辑节点，并回看每次保存的历史版本。

这是一个 **Codex 本地插件**，不是需要常驻网页服务器的 SaaS。Codex 启动插件内的 stdio MCP 服务，并显示打包在插件内的交互界面；正常使用不需要访问 `127.0.0.1`。

## 能做什么

- 从当前可见对话或用户提供的规划创建地图；按问题分出多个顶层主题，而不是机械地按消息顺序排列。
- 通过 Codex 增量增加、修改、移动或删除主题与节点；每次写入形成不可变版本，保留修改原因和可用的来源线索。
- 在地图界面中查看分支/关联、切换横向或纵向布局、缩放、切换浅色/深色等主题，并轻量编辑节点。
- 导出结构化 JSON；菜单可切换中文/英文，原对话内容不会被自动翻译。

**当前边界：**插件不会自动监听每轮聊天，也不会在未经宿主授权时读取其他 Codex 任务。想更新地图，需要在任务中明确请 Codex 更新，或在图内手工编辑。插件界面能否永久固定在右侧由 Codex 宿主决定。规划脑图的完整自由拖动、导入外部脑图等仍属于桌面原型能力，尚未进入本插件。详见 [插件能力说明](plugins/shendumao-context-map/README.md)。

## 在另一台电脑安装（Windows / macOS）

先安装 Codex 和 **Node.js 18 或更高版本**，并确认终端可以运行 `codex --version` 与 `node --version`。本仓库已经提交运行用的单文件服务包与网页资源，普通安装无需执行 `npm install`、`npm run build`，也不需要单独启动服务。

### 推荐：把仓库地址交给 Codex 安装

在要使用插件的电脑上，打开具有本机终端和网络访问能力的 Codex 任务，发送：

> 请帮我安装这个 Codex 插件：https://github.com/signerzwb/shendumao-codex-context-map 。先阅读仓库 README，检查 Node.js 和 Codex 是否可用，再按 README 中的 GitHub marketplace 步骤安装并验证结果。需要执行命令或联网授权时请让我确认；不要运行仓库以外的安装脚本。最后告诉我是否需要重启 Codex。

这不是“只粘贴链接就自动安装”的特殊功能；Codex 仍需按以下步骤执行命令，且可能受本机权限、网络或组织策略限制。如果当前任务没有终端能力，使用下面的手动方式。

### 手动安装

在 PowerShell（Windows）或 Terminal（macOS）中运行：

```sh
codex plugin marketplace add signerzwb/shendumao-codex-context-map
codex plugin marketplace list
codex plugin add shendumao-context-map@shendumao
codex plugin list
```

也可以在 Codex 桌面版的插件目录中选择 `神都猫` 来源，再安装 `神都猫脉络`。安装后**完全退出并重新打开 Codex，创建一个新任务**，让新任务加载插件的技能与 MCP 工具。

可用这句话开始：

> 用神都猫脉络把当前对话整理成一张思路地图，保留初心、分支、决定理由和下一步，并打开地图。

如需根据指定的历史任务建立地图，可以提供 `codex://threads/...` 链接，但只有当前宿主实际提供相应任务读取能力时才能读取；否则需要先打开该任务或提供导出的内容。

### 更新

仓库发布新版本后：

```sh
codex plugin marketplace upgrade shendumao
codex plugin add shendumao-context-map@shendumao
```

然后重启 Codex 并新建任务。地图数据存储在独立的用户数据目录，更新插件代码不会删除它；重要地图仍建议自行备份。

### 卸载和数据

用 `codex plugin list` 确认安装状态；如要卸载，先运行 `codex plugin remove shendumao-context-map@shendumao`。**卸载插件与删除地图数据是不同操作**：不要直接删除数据目录，除非已经备份且明确不再需要。默认数据位置和 `SHENDUMAO_DATA_DIR` 覆盖方式见[插件说明](plugins/shendumao-context-map/README.md#持久化位置)。

## 项目结构

```text
.agents/plugins/marketplace.json        Codex marketplace 目录
plugins/shendumao-context-map/
  .codex-plugin/plugin.json             插件元数据
  .mcp.json                             Codex 启动 MCP 的配置
  mcp/server.bundle.mjs                 已打包的跨平台 Node 服务
  assets/context-map-widget.html        自包含交互界面
  skills/visualize-context/SKILL.md     对话整理规则
  tests/                                自动测试
```

`marketplace.json` 使用仓库内的相对路径，不包含开发电脑的绝对路径。因此安装源可以是 GitHub 仓库、克隆后的本地目录，或 Codex 支持的其他 marketplace 来源。

## 开发与验证

在 `plugins/shendumao-context-map` 中运行：

```sh
npm ci
npm run build
npm test
```

代码更改后要重新构建并提交 `mcp/server.bundle.mjs`；仅修改源码而不更新 bundle，不会改变用户安装后的实际服务。GitHub Actions 在 Windows 和 macOS 上运行构建与测试。发布更新时同步提升插件版本，并在另一台机器重新执行 marketplace upgrade / plugin add。

## 隐私与来源

地图默认只保存在本机。插件的 MCP 服务只接收 Codex 显式传给它的参数，不会自行抓取任务数据库或后台监听对话。示例地图是演示数据，不包含用户的完整历史对话。整理时应保留原文，明确区分用户原话、AI 报告、归纳与推测。

## 交流与反馈

QQ 交流群：**340983417**。欢迎反馈安装问题、地图体验与功能建议；报告故障时请勿公开粘贴包含私人对话或凭据的地图文件。

## 许可

[MIT](LICENSE) · 作者：神都猫
