import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(root, "../..");
const template = readFileSync(resolve(root, "assets/context-map-widget.html"), "utf8");
const map = JSON.parse(readFileSync(resolve(root, "assets/demo-map.json"), "utf8"));
const payload = {
  kind: "map",
  schemaVersion: 2,
  status: "ready",
  mapId: "demo",
  revision: 0,
  title: map.title,
  origin: map.origin,
  stats: {
    topics: map.topics.length,
    nodes: map.topics.reduce((count, topic) => count + topic.nodes.length, 0),
  },
  map,
};
const safePayload = JSON.stringify(payload).replaceAll("<", "\\u003c");
const marker = "/*__SHENDUMAO_DEMO__*/ null";
if (!template.includes(marker)) throw new Error("演示数据占位符已改变，请检查实际组件模板。");

const demoBootstrap = `<script>
(() => {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");
  const direction = params.get("direction");
  if (["light", "dark", "ocean", "paper"].includes(theme) || ["vertical", "horizontal"].includes(direction)) {
    sessionStorage.setItem("shendumao-context-map-view", JSON.stringify({
      theme: ["light", "dark", "ocean", "paper"].includes(theme) ? theme : "light",
      direction: direction === "horizontal" ? "horizontal" : "vertical",
      language: "zh",
    }));
  }
  addEventListener("load", () => {
    const focus = params.get("focus");
    if (focus) setTimeout(() => {
      const node = [...document.querySelectorAll("[data-node-id]")].find((item) => item.dataset.nodeId === focus);
      node?.click();
    }, 100);
  });
})();
</script>`;

const html = template
  .replace(marker, safePayload)
  .replace("<script>\n(() => {", `${demoBootstrap}\n<script>\n(() => {`);
const output = resolve(repositoryRoot, "docs/demo.html");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, html);
console.log(`已生成 ${output}`);
