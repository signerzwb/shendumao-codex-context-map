import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = process.env.SHENDUMAO_PLUGIN_ROOT
  ? resolve(process.env.SHENDUMAO_PLUGIN_ROOT)
  : sourceRoot;
const serverPath = resolve(pluginRoot, "mcp/server.bundle.mjs");
const UI_URI = "ui://shendumao/context-map-v1.html";

async function withTemporaryData(run) {
  const dataRoot = await mkdtemp(join(tmpdir(), "shendumao-mcp-test-"));
  try {
    return await run(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function withClient(dataRoot, run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: pluginRoot,
    env: { ...process.env, SHENDUMAO_DATA_DIR: dataRoot, SHENDUMAO_DISABLE_AUTO_OPEN: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "shendumao-smoke-test", version: "0.2.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

test("WorkBuddy 版通过本机浏览器提供地图与受保护的编辑接口", { skip: !process.env.SHENDUMAO_PLUGIN_ROOT }, async () => {
  await withTemporaryData(async (dataRoot) => withClient(dataRoot, async (client) => {
    const created = await client.callTool({ name: "prepare_context_map", arguments: {
      mutationId: "browser-create",
      map: { title: "浏览器测试", origin: "从想法开始", topics: [{ title: "路径", nodes: [{ title: "第一步" }] }] },
    } });
    const mapId = created.structuredContent.mapId;
    const opened = await client.callTool({ name: "render_context_map", arguments: { mapId } });
    const url = opened.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/view\?[^\s（]+/)?.[0];
    assert.ok(url, opened.content[0].text);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /浏览器测试/);
    assert.match(html, /window\.openai/);
    const parsed = new URL(url);
    const rejected = await fetch(`${parsed.origin}/view?mapId=${mapId}`);
    assert.equal(rejected.status, 403);
    const csrf = await fetch(`${parsed.origin}/api/call`, { method: "POST", headers: { "Content-Type": "application/json", Origin: parsed.origin }, body: JSON.stringify({ name: "get_context_map", args: { mapId } }) });
    assert.equal(csrf.status, 403);
    const headers = { "Content-Type": "application/json", "X-Shendumao-Token": parsed.searchParams.get("token"), Origin: parsed.origin };
    const read = await fetch(`${parsed.origin}/api/call`, { method: "POST", headers, body: JSON.stringify({ name: "get_context_map", args: { mapId } }) });
    assert.equal(read.status, 200);
    const current = await read.json();
    const nodeId = current.structuredContent.map.topics[0].nodes[0].id;
    const saved = await fetch(`${parsed.origin}/api/call`, { method: "POST", headers, body: JSON.stringify({ name: "update_context_map", args: {
      mapId, expectedRevision: 1, mutationId: "browser-edit", operations: [{ type: "update_node", nodeId, patch: { title: "第二步" } }], change: { kind: "manual", summary: "浏览器编辑" },
    } }) });
    assert.equal(saved.status, 200);
    const updated = await saved.json();
    assert.equal(updated.structuredContent.revision, 2);
    assert.equal(updated.structuredContent.map.topics[0].nodes[0].title, "第二步");
    const history = await client.callTool({ name: "render_context_map", arguments: { mapId, revision: 1 } });
    const historyUrl = history.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/view\?[^\s（]+/)?.[0];
    const historyHtml = await (await fetch(historyUrl)).text();
    assert.match(historyHtml, /SHENDUMAO_HISTORY_READ_ONLY=true/);
  }));
});

test("MCP 服务公开持久化、版本与编辑工具，并返回自包含 UI resource", async () => {
  await withTemporaryData(async (dataRoot) => withClient(dataRoot, async (client) => {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "get_context_map",
      "list_context_map_revisions",
      "list_context_maps",
      "prepare_context_map",
      "render_context_map",
      "update_context_map",
    ]);
    const renderTool = listed.tools.find((tool) => tool.name === "render_context_map");
    const prepareTool = listed.tools.find((tool) => tool.name === "prepare_context_map");
    const updateTool = listed.tools.find((tool) => tool.name === "update_context_map");
    assert.equal(renderTool._meta?.ui?.resourceUri, UI_URI);
    assert.deepEqual(renderTool._meta?.ui?.visibility, ["model"]);
    assert.equal(renderTool.annotations?.readOnlyHint, true);
    assert.ok(renderTool.outputSchema.properties.map);
    assert.ok(prepareTool.inputSchema.required.includes("mutationId"));
    assert.equal(prepareTool.annotations?.idempotentHint, true);
    assert.equal(updateTool.annotations?.readOnlyHint, false);
    assert.equal(updateTool.annotations?.destructiveHint, true);
    assert.equal(updateTool.annotations?.idempotentHint, true);
    assert.ok(updateTool.outputSchema.properties.map);
    assert.deepEqual(updateTool._meta?.ui?.visibility, ["model", "app"]);
    assert.equal(updateTool._meta?.["openai/widgetAccessible"], true);

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === UI_URI));
    const resource = await client.readResource({ uri: UI_URI });
    assert.equal(resource.contents.length, 1);
    assert.equal(resource.contents[0].uri, UI_URI);
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
    const html = resource.contents[0].text;
    assert.match(html, /ui\/notifications\/tool-result/);
    assert.match(html, /ui\/initialize/);
    assert.match(html, /ui\/notifications\/initialized/);
    assert.match(html, /ui\/download-file/);
    assert.match(html, /tools\/call/);
    assert.match(html, /update_context_map/);
    assert.match(html, /node-dialog/);
    assert.match(html, /context-menu/);
    assert.match(html, /\.empty\[hidden\]\{display:none\}/);
    assert.match(html, /window\.parent===window/);
    assert.doesNotMatch(html, /127\.0\.0\.1:4317|localhost:4317/);
    assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=["'](?:\.|\/|[A-Za-z]:\\)/i);
  }));
});

test("地图跨 MCP 重启保留，增量更新有 revision、历史与冲突保护", async () => {
  await withTemporaryData(async (dataRoot) => {
    let mapId;
    await withClient(dataRoot, async (client) => {
      const demo = await client.callTool({ name: "render_context_map", arguments: {} });
      assert.equal(demo.isError, undefined);
      assert.equal(demo.structuredContent.mapId, "demo");
      assert.equal(demo.structuredContent.revision, 0);
      assert.ok(demo.structuredContent.map.topics.length > 0);
      assert.equal(demo.structuredContent.sourceCheckpoint, null);
      assert.equal(demo._meta.widgetData.mapId, "demo");

      const prepared = await client.callTool({
        name: "prepare_context_map",
        arguments: {
          mutationId: "test-create-保持原文",
          change: { kind: "analysis", summary: "从指定任务建立首版" },
          sourceCheckpoint: { sourceTask: "codex://threads/test", lastTurnId: "turn-8", observedAt: "2026-09-12T08:00:00Z" },
          map: {
            title: "保持原文",
            origin: "为什么开始",
            sourceTask: "codex://threads/test",
            topics: [{
              title: "第一个主题",
              nodes: [
                { id: "A_B", title: "用户写下的内容", quote: "不要翻译我", speaker: "用户", sourceRefs: [{ taskId: "test", turnId: "turn-8", role: "user", excerpt: "不要翻译我" }] },
                { id: "join", title: "跨分支汇合", related: "A_B" },
                { id: "english-user", title: "English speaker label", quote: "Keep my wording", speaker: "User" },
              ],
            }],
          },
        },
      });
      assert.equal(prepared.isError, undefined);
      assert.match(prepared.structuredContent.mapId, /^map-[0-9a-f-]{36}$/);
      assert.equal(prepared.structuredContent.revision, 1);
      assert.equal(prepared.structuredContent.status, "created");
      assert.equal(prepared.structuredContent.map, undefined);
      assert.match(prepared.content[0].text, new RegExp(`mapId=${prepared.structuredContent.mapId}`));
      mapId = prepared.structuredContent.mapId;
    });

    await withClient(dataRoot, async (client) => {
      const fetched = await client.callTool({ name: "get_context_map", arguments: { mapId } });
      assert.equal(fetched.structuredContent.revision, 1);
      assert.equal(fetched.structuredContent.map.title, "保持原文");
      assert.equal(fetched.structuredContent.map.topics[0].nodes[0].quote, "不要翻译我");
      assert.equal(fetched.structuredContent.map.topics[0].nodes[0].evidence, "user-stated");
      assert.equal(fetched.structuredContent.map.topics[0].nodes[0].sourceRefs[0].excerpt, "不要翻译我");
      assert.equal(fetched.structuredContent.map.topics[0].nodes[1].related, "a-b");
      assert.equal(fetched.structuredContent.map.topics[0].nodes[2].evidence, "user-stated");
      assert.equal(fetched.structuredContent.sourceCheckpoint.lastTurnId, "turn-8");

      const updateArguments = {
        mapId,
        expectedRevision: 1,
        mutationId: "test-update-1",
        change: { kind: "manual", summary: "图内添加一个手工节点" },
        operations: [{
          type: "add_node",
          topicId: fetched.structuredContent.map.topics[0].id,
          afterNodeId: "a-b",
          node: { id: "manual-1", title: "一段自然语言", quote: "一段自然语言\n也可以被 Codex 理解", speaker: "用户", evidence: "manual" },
        }],
      };
      const updated = await client.callTool({ name: "update_context_map", arguments: updateArguments });
      assert.equal(updated.isError, undefined);
      assert.equal(updated.structuredContent.status, "saved");
      assert.equal(updated.structuredContent.revision, 2);
      assert.equal(updated.structuredContent.map.topics[0].nodes[1].id, "manual-1");
      assert.match(updated.content[0].text, new RegExp(`mapId=${mapId}`));
      assert.equal(updated._meta.widgetData.map.topics[0].nodes[1].id, "manual-1");

      const retried = await client.callTool({ name: "update_context_map", arguments: updateArguments });
      assert.equal(retried.structuredContent.revision, 2);
      assert.equal(retried.structuredContent.map.topics[0].nodes.filter((node) => node.id === "manual-1").length, 1);
      assert.equal(retried._meta.widgetData.map.topics[0].nodes.filter((node) => node.id === "manual-1").length, 1);

      const historical = await client.callTool({ name: "get_context_map", arguments: { mapId, revision: 1 } });
      assert.equal(historical.structuredContent.map.topics[0].nodes.some((node) => node.id === "manual-1"), false);
      const current = await client.callTool({ name: "get_context_map", arguments: { mapId } });
      assert.equal(current.structuredContent.revision, 2);
      assert.equal(current.structuredContent.map.topics[0].nodes[1].id, "manual-1");

      const listed = await client.callTool({ name: "list_context_maps", arguments: {} });
      assert.equal(listed.structuredContent.maps.length, 1);
      assert.equal(listed.structuredContent.maps[0].revision, 2);
      assert.match(listed.content[0].text, new RegExp(mapId));
      assert.match(listed.content[0].text, /revision=2/);
      const revisions = await client.callTool({ name: "list_context_map_revisions", arguments: { mapId } });
      assert.deepEqual(revisions.structuredContent.revisions.map((item) => item.revision), [2, 1]);
      assert.equal(revisions.structuredContent.revisions[0].change.summary, "图内添加一个手工节点");

      const conflict = await client.callTool({
        name: "update_context_map",
        arguments: {
          mapId,
          expectedRevision: 1,
          mutationId: "test-stale-update",
          change: { kind: "analysis", summary: "用过期版本更新" },
          operations: [{ type: "set_map", patch: { compass: "不应覆盖" } }],
        },
      });
      assert.equal(conflict.isError, undefined);
      assert.equal(conflict.structuredContent.status, "conflict");
      assert.equal(conflict.structuredContent.revision, 2);
      assert.equal(conflict.structuredContent.expectedRevision, 1);
      assert.equal(conflict.structuredContent.map.topics[0].nodes[1].id, "manual-1");

      const rendered = await client.callTool({ name: "render_context_map", arguments: { mapId } });
      assert.equal(rendered._meta?.ui?.resourceUri, UI_URI);
      assert.equal(rendered.structuredContent.revision, 2);
      assert.equal(rendered.structuredContent.map.topics[0].nodes[1].title, "一段自然语言");
      assert.equal(rendered._meta.widgetData.map.topics[0].nodes[1].title, "一段自然语言");

      const missing = await client.callTool({ name: "get_context_map", arguments: { mapId: "missing" } });
      assert.equal(missing.isError, true);
      const missingRender = await client.callTool({ name: "render_context_map", arguments: { mapId: "missing" } });
      assert.equal(missingRender.isError, true);
      assert.match(missingRender._meta.widgetError, /没有找到地图/);
    });
  });
});
