import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, "mcp/server.mjs")],
  outfile: resolve(root, "mcp/server.bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  logLevel: "info",
});
await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, "mcp/server.mjs")],
  outfile: resolve(root, "../shendumao-context-map-workbuddy/mcp/server.bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  define: { "process.env.SHENDUMAO_HOST": '"workbuddy"' },
  logLevel: "info",
});
