import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const MAX_BODY_BYTES = 1_000_000;

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function send(response, status, body, type = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:; form-action 'none'; base-uri 'none'",
  });
  response.end(body);
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw new Error("请求内容过大。");
  }
  return JSON.parse(body);
}

function launchBrowser(url) {
  if (process.env.SHENDUMAO_DISABLE_AUTO_OPEN === "1") return Promise.resolve({ launched: false, reason: "自动打开已禁用" });
  const platform = process.platform;
  const command = platform === "win32" ? "explorer.exe" : platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve) => {
    const child = spawn(command, [url], { stdio: "ignore", windowsHide: true, detached: true });
    child.once("error", (error) => resolve({ launched: false, reason: error.message }));
    child.once("spawn", () => { child.unref(); resolve({ launched: true }); });
  });
}

export function createBrowserView({ widgetTemplate, loadResult, invokeTool }) {
  const token = randomBytes(32).toString("hex");
  let httpServer;
  let baseUrl;

  async function handle(request, response) {
    const requestUrl = new URL(request.url || "/", baseUrl);
    if (request.headers.host !== new URL(baseUrl).host) return send(response, 403, "Forbidden");
    if (requestUrl.pathname === "/view" && request.method === "GET") {
      if (requestUrl.searchParams.get("token") !== token) return send(response, 403, "Forbidden");
      const mapId = requestUrl.searchParams.get("mapId") || "demo";
      const rawRevision = requestUrl.searchParams.get("revision");
      const revision = rawRevision === null ? undefined : Number(rawRevision);
      if (rawRevision !== null && (!Number.isSafeInteger(revision) || revision < 1)) return send(response, 400, "Invalid revision");
      const result = await loadResult(mapId, revision);
      if (result.isError) return send(response, 404, result.content?.[0]?.text || "Map not found");
      const payload = result.structuredContent;
      const bootstrap = `<script>window.SHENDUMAO_HISTORY_READ_ONLY=${revision !== undefined};window.openai={toolOutput:${safeJson(payload)},callTool:async(name,args)=>{const response=await fetch('/api/call',{method:'POST',headers:{'Content-Type':'application/json','X-Shendumao-Token':'${token}'},body:JSON.stringify({name,args})});return response.json()},requestDisplayMode:async({mode})=>{if(mode==='fullscreen')await document.documentElement.requestFullscreen();else if(document.fullscreenElement)await document.exitFullscreen();return {mode}}};${revision === undefined && mapId !== "demo" ? `let lastRevision=${payload.revision};setInterval(async()=>{try{const result=await window.openai.callTool('get_context_map',{mapId:${safeJson(mapId)}});const next=result.structuredContent;if(next&&next.revision!==lastRevision){lastRevision=next.revision;window.openai.toolOutput=next;window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{toolOutput:next}}}))}}catch{}},4000);` : ""}</script>`;
      const html = widgetTemplate.replace("</head>", `${bootstrap}</head>`);
      return send(response, 200, html, "text/html; charset=utf-8");
    }
    if (requestUrl.pathname === "/api/call" && request.method === "POST") {
      if (request.headers["x-shendumao-token"] !== token || request.headers.origin !== baseUrl) return send(response, 403, "Forbidden");
      try {
        const { name, args } = await readJson(request);
        if (name !== "get_context_map" && name !== "update_context_map") return send(response, 403, "Forbidden");
        const result = await invokeTool(name, args);
        return send(response, 200, JSON.stringify(result), "application/json; charset=utf-8");
      } catch (error) {
        return send(response, 400, JSON.stringify({ isError: true, content: [{ type: "text", text: error.message }] }), "application/json; charset=utf-8");
      }
    }
    send(response, 404, "Not found");
  }

  async function ensureStarted() {
    if (baseUrl) return baseUrl;
    httpServer = createServer((request, response) => {
      handle(request, response).catch(() => send(response, 500, "Internal error"));
    });
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
    return baseUrl;
  }

  return {
    async open(mapId = "demo", revision) {
      const base = await ensureStarted();
      const url = new URL("/view", base);
      url.searchParams.set("token", token);
      url.searchParams.set("mapId", mapId);
      if (revision !== undefined) url.searchParams.set("revision", String(revision));
      const launch = await launchBrowser(url.href);
      return { url: url.href, ...launch };
    },
    close() { httpServer?.close(); },
  };
}
