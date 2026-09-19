# 神都猫脉络 · WorkBuddy 版（0.3.0 待实机验收）

WorkBuddy 版与 Codex 版共享地图数据模型、版本保存和画布组件，但有独立的展示方式：调用 `render_context_map` 时，插件在本机启动临时网页服务，并尝试用系统默认浏览器打开地图。**不再依赖 WorkBuddy 是否渲染 MCP Apps 画布。**服务只监听 `127.0.0.1`，使用自动分配的端口；关闭 WorkBuddy 对应 MCP 进程后页面会失效，再次调用即可重新打开。

这不是公网网站，也不需要手工启动 Web 框架。当前已通过 Windows 本地 MCP、HTTP 读取/编辑接口自动测试；**WorkBuddy 桌面端自动唤起默认浏览器及 macOS 实机仍需验收**，因此暂不宣称所有电脑都能即装即用。

## 安装

1. 安装 WorkBuddy 和 Node.js 18 或更高版本；在终端运行 `node --version` 确认命令可用。
2. 在 WorkBuddy「插件」页添加第三方市场 `https://github.com/signerzwb/shendumao-codex-context-map`（若界面要求 `owner/repo`，填 `signerzwb/shendumao-codex-context-map`）。
3. 安装 `shendumao-context-map@shendumao-workbuddy`，按 WorkBuddy 提示重载插件或新建任务。
4. 对 WorkBuddy 说：“请用神都猫脉络打开虚构演示图。”它应调用 `render_context_map`；默认浏览器应出现可缩放的演示地图。若自动打开被系统阻止，工具回执会包含本机 URL，可点击打开。

插件包已包含构建好的 `mcp/server.bundle.mjs`，普通用户无需 `npm install` 或构建。WorkBuddy 能否通过对话直接完成市场安装，取决于其当前版本和权限；不能把“给了安装指令”视为已安装。

### GitHub 访问不畅时

官方地址始终是 `https://github.com/signerzwb/shendumao-codex-context-map`。若无法直连，可自行决定是否使用第三方下载代理 `https://gh-proxy.org/https://github.com/signerzwb/shendumao-codex-context-map/archive/refs/heads/main.zip` 获取仓库 ZIP，再由 WorkBuddy 尝试添加解压后的本地插件市场。代理不属于本项目，不保证长期可用或内容可信；不要向代理输入 GitHub 密码或令牌。ZIP 安装不会自动跟随仓库更新。

如果插件市场暂时不识别此包，可以只为诊断在 WorkBuddy 的 MCP 配置中添加 `.mcp.json` 所示的本地服务；这不会自动安装整理规则 Skill，不能视为完整安装。不要覆盖已有 MCP 服务配置。

## 使用

- 演示：`render_context_map` 不传 `mapId`，打开只读虚构地图。
- 从可见对话或用户提供内容创建真实地图：先 `prepare_context_map`，再 `render_context_map`。
- 继续对话后手动请 WorkBuddy 更新：先 `get_context_map`，再 `update_context_map`，最后 `render_context_map`。插件不会后台读取或自动监听所有对话。
- 浏览器画布可切换横/纵布局和风格、缩放、查看节点详情、编辑和导出。编辑通过本机接口保存为新版本；已打开的最新版页面会定期检查地图更新。
- 历史版本通过 `list_context_map_revisions` 与带 `revision` 的 `render_context_map` 回看，历史页面只供回看。

## 安全与数据

本机服务仅绑定 `127.0.0.1`，端口随机，页面和编辑接口需要进程内生成的随机令牌；接口还检查浏览器来源。请勿把含令牌的本机 URL 发给他人。它只在本机有效，无法当作可分享的公网链接。地图默认存在用户数据目录，更新插件不会主动删除地图。

WorkBuddy 与 Codex 的地图存储不保证自动互通；不要直接覆盖数据目录。需要迁移时先备份，再明确设置 `SHENDUMAO_DATA_DIR`。卸载插件不会自动清除地图数据。

## 尚待验收

- WorkBuddy 5.5.6 桌面端是否允许插件 MCP 进程唤起系统浏览器，以及插件安装后的完整流程。
- macOS 的安装、自动打开和浏览器编辑流程。
- 不预装 Node.js 的新电脑能否由 WorkBuddy 引导安装运行时；当前包仍要求 Node.js 18+。

若失败，请反馈 WorkBuddy 版本、操作系统、安装方式、工具回执和是否出现浏览器页面；不要公开发送私人地图内容或含令牌的完整 URL。

QQ 交流群：**340983417**。
