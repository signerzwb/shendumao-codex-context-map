import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(root, "plugins/shendumao-context-map");
const target = resolve(root, "plugins/shendumao-context-map-workbuddy");
const files = [
  "mcp/server.bundle.mjs",
  "assets/context-map-widget.html",
  "assets/demo-map.json",
  "LICENSE",
];
const check = process.argv.includes("--check");

for (const relativePath of files) {
  const sourcePath = resolve(source, relativePath);
  const targetPath = resolve(target, relativePath);
  if (check) {
    if (!existsSync(targetPath) || !readFileSync(sourcePath).equals(readFileSync(targetPath))) {
      throw new Error(`WorkBuddy 插件内的 ${relativePath} 与主版本不一致；请运行 node scripts/sync-workbuddy.mjs`);
    }
  } else {
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

const codexManifest = JSON.parse(readFileSync(resolve(source, ".codex-plugin/plugin.json"), "utf8"));
const workbuddyManifest = JSON.parse(readFileSync(resolve(target, ".codebuddy-plugin/plugin.json"), "utf8"));
const marketplace = JSON.parse(readFileSync(resolve(root, ".codebuddy-plugin/marketplace.json"), "utf8"));
const mcp = JSON.parse(readFileSync(resolve(target, ".mcp.json"), "utf8"));
if (codexManifest.version !== workbuddyManifest.version || workbuddyManifest.version !== marketplace.plugins[0]?.version) {
  throw new Error("Codex、WorkBuddy 与 marketplace 的插件版本不一致。");
}
if (marketplace.plugins[0]?.name !== workbuddyManifest.name || marketplace.plugins[0]?.source !== "./plugins/shendumao-context-map-workbuddy") {
  throw new Error("WorkBuddy marketplace 没有指向本仓库内的插件目录。");
}
if (!existsSync(resolve(target, "skills/visualize-context/SKILL.md")) || workbuddyManifest.skills !== "./skills/") {
  throw new Error("WorkBuddy 整理规则未正确打包。");
}
const server = mcp.mcpServers?.shendumaoContextMap;
if (server?.type !== "stdio" || server.command !== "node" || server.args?.[0] !== "${CODEBUDDY_PLUGIN_ROOT}/mcp/server.bundle.mjs" || server.cwd !== "${CODEBUDDY_PLUGIN_ROOT}") {
  throw new Error("WorkBuddy 本地 MCP 启动配置不正确。");
}
console.log(check ? "WorkBuddy 插件文件与主版本一致。" : "已同步 WorkBuddy 插件运行文件。");
