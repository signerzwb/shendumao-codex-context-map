# 神都猫脉络 · WorkBuddy 试用版

这是同一地图核心的 WorkBuddy 适配包，包含 WorkBuddy 插件清单、技能和本地 stdio MCP 服务。地图默认保存在本机，不需要单独启动网页服务器。**目前只完成了插件结构和 MCP 端的验证；你安装的 WorkBuddy 桌面版能否渲染 MCP Apps 画布，仍需在宿主中实测。**

## 安装前

- 电脑已安装 WorkBuddy、Node.js 18 或更高版本；终端里运行 `node --version` 能看到版本号。
- 通过 GitHub 插件市场安装时，需要能访问 GitHub；若市场使用 Git 克隆，也需要安装 Git。
- 不需要 `npm install` 或构建；本插件已包含可直接运行的 `mcp/server.bundle.mjs`。

## 方法一：在 WorkBuddy 插件页安装（优先试）

1. 打开 WorkBuddy 左侧的「插件」。
2. 找到添加第三方插件市场的「+」入口，填入 `https://github.com/signerzwb/shendumao-codex-context-map`。如果界面要求 `owner/repo` 格式，改填 `signerzwb/shendumao-codex-context-map`。
3. 在新来源 `shendumao-workbuddy` 下找到并安装 `shendumao-context-map`（神都猫脉络）。如出现本地代码/MCP 信任提示，核对来源后再决定是否允许。
4. 重启 WorkBuddy 或按界面提示重新加载插件，开启新任务。先发送下方的演示测试句。

如果你使用的是 CodeBuddy Code 命令界面，也可在其对话输入 `/plugin marketplace add signerzwb/shendumao-codex-context-map`，然后输入 `/plugin install shendumao-context-map@shendumao-workbuddy`、`/reload-plugins`。这是 **CodeBuddy Code** 官方文档中的命令；WorkBuddy 桌面版若不认识这些斜杠命令，请使用上面的插件页，不要把它们当作系统终端命令。

## 安装后的三步测试

先让 WorkBuddy 运行：

> 请调用神都猫脉络的 `render_context_map`，不传 `mapId`，只打开虚构演示图。告诉我 MCP 工具是否调用成功，以及界面里是否出现可点击、可缩放的地图。

若地图出现，再试切换横向/纵向、深色风格、点一个节点查看详情。随后可以用当前可见的几段对话建立一张真实地图，并试一次增量更新。若工具调用成功但只有文本、没有画布，请记录 WorkBuddy 版本和界面提示：这说明 MCP 核心已接通，但图形宿主兼容性仍未通过。

## 方法二：插件市场不识别时，先测 MCP

下载或克隆整个仓库，不要只下载 `.mcp.json`。在 WorkBuddy 的「插件 → MCP 服务器 → 配置 MCP」中，按其提示添加本地服务器；如果已有其他 MCP 配置，只把 `shendumaoContextMap` 合并进现有 `mcpServers`，不要覆盖其他服务。下面的路径要改成你电脑上**实际存在的绝对路径**；Windows 的 JSON 路径建议使用 `/`：

```json
{
  "mcpServers": {
    "shendumaoContextMap": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/你的目录/shendumao-codex-context-map/plugins/shendumao-context-map-workbuddy/mcp/server.bundle.mjs"]
    }
  }
}
```

macOS 示例把 `args` 的路径换成 `/Users/你的用户名/.../mcp/server.bundle.mjs`。这个回退方法只接入 MCP 工具，不一定会自动安装整理规则 Skill。配置成功后仍用上面的演示测试句验证。

## 当前边界

- 不会后台监听每轮对话，也不会自动读取 Codex 或 WorkBuddy 的其他任务；只整理当前可见内容或用户明确提供且宿主实际允许读取的内容。
- WorkBuddy 与 Codex 的地图数据不会保证自动互通。不要为了共享地图直接覆盖数据目录；需要迁移时先备份，再明确设置 `SHENDUMAO_DATA_DIR`。
- 地图能否固定在右侧由 WorkBuddy 宿主决定。若当前版本不支持 MCP Apps UI，仍可通过 MCP 工具获取结构化地图，但不能宣称图形插件已完整运行。
- 如果安装失败，请反馈 WorkBuddy 版本、操作系统、安装方式、MCP 服务器状态及具体报错；不要公开发送含私人对话的地图文件。

交流 QQ 群：**340983417**。
