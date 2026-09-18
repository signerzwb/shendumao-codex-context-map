import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
await build({
  absWorkingDir: root,
  entryPoints: ["./mcp/server.mjs"],
  outfile: "mcp/server.bundle.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  logLevel: "info",
});
