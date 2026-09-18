import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const widget = readFileSync(new URL("../assets/context-map-widget.html", import.meta.url), "utf8");

function sourceLine(fragment) {
  const line = widget.split(/\r?\n/).find((candidate) => candidate.includes(fragment));
  assert.ok(line, `没有找到 ${fragment}`);
  return line;
}

test("响应 MCP Apps 的 resource teardown 请求", () => {
  const handler = sourceLine('message.method==="ui/resource-teardown"');
  assert.match(handler, /postMessage\(\{jsonrpc:"2\.0",id:message\.id,result:\{\}\},"\*"\)/);
});

test("工具错误保留已加载地图，首次加载错误仍显示空态", () => {
  const handler = sourceLine("function applyToolResult");
  assert.match(handler, /if\(state\.payload\)\{setSaveState\("saveFailed","error"\);notify\(error\);return false\}/);
  assert.doesNotMatch(handler, /state\.payload\s*=\s*null/);
  assert.match(handler, /\$\("empty"\)\.hidden=false/);
  assert.match(handler, /\$\("empty"\)\.classList\.add\("error"\)/);
});

test("收到缺少地图的工具结果时明确显示诊断，不静默等待", () => {
  const handler = sourceLine("function applyToolResult");
  assert.match(handler, /if\(reportMissing\)/);
  assert.match(handler, /t\("missingMap"\)/);
  assert.match(widget, /ui\/notifications\/tool-result"\)applyToolResult\(message\.params\?\.result\?\?message\.params,true\)/);
});

test("MCP Apps 握手失败时保留原因供图内工具错误提示", () => {
  assert.match(sourceLine("function initializeBridge"), /bridgeFailure=error\?\.message\|\|String\(error\)/);
  assert.match(sourceLine("async function callMapTool"), /bridgeFailure/);
});

test("手工节点日期使用本地年月日而非 UTC 日期", () => {
  const handler = sourceLine("function today");
  assert.match(handler, /getFullYear\(\)/);
  assert.match(handler, /getMonth\(\)\+1/);
  assert.match(handler, /getDate\(\)/);
  assert.doesNotMatch(handler, /toISOString/);
});

test("删除确认明确说明会清除指向节点的关联线", () => {
  assert.match(widget, /这些关联线也会一并清除/);
  assert.match(widget, /links from other nodes to this one will also be removed/);
});

test("兼容 window.openai 的 canonical mcp_tool_result 元数据封装", () => {
  const helper = sourceLine("function openAiToolResult");
  assert.match(helper, /metadata\?\.mcp_tool_result\|\|metadata\?\.call_tool_result/);
  assert.match(widget, /applyToolResult\(openAiToolResult\(globals\),globals\.toolOutput/);
  assert.match(widget, /applyToolResult\(openAiToolResult\(window\.openai\)\)/);
});
