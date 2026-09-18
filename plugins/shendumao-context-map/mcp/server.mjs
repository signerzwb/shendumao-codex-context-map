import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyMapOperations, MapOperationError } from "./operations.mjs";
import {
  IdempotencyKeyReuseError,
  MapRepository,
  RevisionConflictError,
} from "./storage.mjs";

const VERSION = "0.2.1";
const UI_URI = "ui://shendumao/context-map-v1.html";
const EVIDENCE_KINDS = ["user-stated", "assistant-reported", "summary", "inference", "manual"];

const sourceRefSchema = z.object({
  taskId: z.string().trim().max(240).optional(),
  turnId: z.string().trim().max(160).optional(),
  messageId: z.string().trim().max(160).optional(),
  role: z.enum(["user", "assistant", "tool", "mixed"]).optional(),
  date: z.string().trim().max(40).optional(),
  excerpt: z.string().trim().max(1200).optional(),
});

const nodeSchema = z.object({
  id: z.string().trim().min(1).max(96).optional(),
  title: z.string().trim().min(1).max(240),
  kind: z.string().trim().max(80).optional(),
  summary: z.string().trim().max(1200).optional(),
  why: z.string().trim().max(2000).optional(),
  change: z.string().trim().max(2000).optional(),
  quote: z.string().trim().max(4000).optional(),
  speaker: z.string().trim().max(80).optional(),
  date: z.string().trim().max(32).optional(),
  related: z.string().trim().max(96).nullable().optional().describe("可选：另一个前置节点的 id，用于绘制跨主题关联或汇合边。"),
  evidence: z.enum(EVIDENCE_KINDS).optional().describe("证据类型。推断必须使用 inference，用户手工添加使用 manual。"),
  sourceRefs: z.array(sourceRefSchema).max(8).optional().describe("可选的来源任务、turn 或 message 引用；没有稳定 ID 时可以只提供日期与摘录。"),
});

const topicSchema = z.object({
  id: z.string().trim().min(1).max(96).optional(),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(1200).optional(),
  nodes: z.array(nodeSchema).max(24).default([]),
});

const mapSchema = z.object({
  title: z.string().trim().min(1).max(240),
  origin: z.string().trim().min(1).max(400),
  kind: z.string().trim().max(80).optional(),
  description: z.string().trim().max(1600).optional(),
  compass: z.string().trim().max(800).optional(),
  end: z.string().trim().max(400).optional(),
  dateRange: z.string().trim().max(64).optional(),
  sourceTask: z.string().trim().max(400).nullable().optional(),
  topics: z.array(topicSchema).min(1).max(12),
});

const normalizedNodeSchema = nodeSchema.extend({
  id: z.string(),
  kind: z.string(),
  summary: z.string(),
  why: z.string(),
  change: z.string(),
  quote: z.string(),
  speaker: z.string(),
  date: z.string(),
  related: z.string().nullable(),
  evidence: z.enum(EVIDENCE_KINDS),
  sourceRefs: z.array(sourceRefSchema),
});

const normalizedTopicSchema = topicSchema.extend({
  id: z.string(),
  description: z.string(),
  nodes: z.array(normalizedNodeSchema),
});

const normalizedMapSchema = mapSchema.extend({
  kind: z.string(),
  description: z.string(),
  compass: z.string(),
  end: z.string(),
  dateRange: z.string(),
  sourceTask: z.string().nullable(),
  topics: z.array(normalizedTopicSchema),
});

const changeSchema = z.object({
  kind: z.enum(["analysis", "manual", "import", "migration", "restore"]).default("analysis"),
  summary: z.string().trim().min(1).max(400),
});

const sourceCheckpointSchema = z.object({
  sourceTask: z.string().trim().max(400).optional(),
  cursor: z.string().trim().max(400).optional(),
  lastTurnId: z.string().trim().max(160).optional(),
  observedAt: z.string().trim().max(64).optional(),
  contentHash: z.string().trim().max(160).optional(),
}).nullable();

const statsSchema = z.object({
  topics: z.number().int().nonnegative(),
  nodes: z.number().int().nonnegative(),
});

const recordSummaryObject = z.object({
  schemaVersion: z.literal(2),
  status: z.enum(["ready", "created", "saved", "conflict"]),
  mapId: z.string(),
  revision: z.number().int().nonnegative(),
  title: z.string(),
  origin: z.string(),
  stats: statsSchema,
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  sourceTask: z.string().nullable(),
  change: changeSchema.nullable(),
  expectedRevision: z.number().int().positive().optional(),
});

const summaryOutputSchema = recordSummaryObject.shape;
const fullOutputSchema = {
  ...summaryOutputSchema,
  map: normalizedMapSchema,
  sourceCheckpoint: sourceCheckpointSchema,
};

const mapPatchSchema = mapSchema.omit({ topics: true }).partial();
const topicPatchSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().max(1200).optional(),
});
const nodePatchSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  kind: z.string().trim().max(80).optional(),
  summary: z.string().trim().max(1200).optional(),
  why: z.string().trim().max(2000).optional(),
  change: z.string().trim().max(2000).optional(),
  quote: z.string().trim().max(4000).optional(),
  speaker: z.string().trim().max(80).optional(),
  date: z.string().trim().max(32).optional(),
  related: z.string().trim().min(1).max(96).nullable().optional(),
  evidence: z.enum(EVIDENCE_KINDS).optional(),
  sourceRefs: z.array(sourceRefSchema).max(8).optional(),
});
const operationNodeSchema = nodeSchema.extend({
  id: z.string().trim().min(1).max(96),
  kind: z.string().trim().max(80).default("节点"),
  summary: z.string().trim().max(1200).default(""),
  why: z.string().trim().max(2000).default(""),
  change: z.string().trim().max(2000).default(""),
  quote: z.string().trim().max(4000).default(""),
  speaker: z.string().trim().max(80).default("未标注"),
  date: z.string().trim().max(32).default(""),
  related: z.string().trim().min(1).max(96).nullable().default(null),
  evidence: z.enum(EVIDENCE_KINDS).default("summary"),
  sourceRefs: z.array(sourceRefSchema).max(8).default([]),
});
const operationTopicSchema = topicSchema.extend({
  id: z.string().trim().min(1).max(96),
  description: z.string().trim().max(1200).default(""),
  nodes: z.array(operationNodeSchema).max(24).default([]),
});
const operationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_map"), patch: mapPatchSchema }),
  z.object({ type: z.literal("add_topic"), topic: operationTopicSchema, afterTopicId: z.string().trim().min(1).max(96).nullable().optional() }),
  z.object({ type: z.literal("update_topic"), topicId: z.string().trim().min(1).max(96), patch: topicPatchSchema }),
  z.object({ type: z.literal("move_topic"), topicId: z.string().trim().min(1).max(96), afterTopicId: z.string().trim().min(1).max(96).nullable().optional() }),
  z.object({ type: z.literal("delete_topic"), topicId: z.string().trim().min(1).max(96), removeIncomingRelations: z.boolean().optional() }),
  z.object({ type: z.literal("add_node"), topicId: z.string().trim().min(1).max(96), node: operationNodeSchema, afterNodeId: z.string().trim().min(1).max(96).nullable().optional() }),
  z.object({ type: z.literal("update_node"), nodeId: z.string().trim().min(1).max(96), patch: nodePatchSchema }),
  z.object({ type: z.literal("move_node"), nodeId: z.string().trim().min(1).max(96), topicId: z.string().trim().min(1).max(96), afterNodeId: z.string().trim().min(1).max(96).nullable().optional() }),
  z.object({ type: z.literal("delete_node"), nodeId: z.string().trim().min(1).max(96), removeIncomingRelations: z.boolean().optional() }),
]);

function text(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function baseId(value, fallback) {
  const compact = text(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return compact || fallback;
}

function uniqueId(preferred, fallback, used) {
  const base = baseId(preferred, fallback);
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function defaultEvidence(item) {
  if (item.evidence) return item.evidence;
  const speaker = text(item.speaker);
  if (item.quote && /^(用户|user|human)$/iu.test(speaker)) return "user-stated";
  if (item.quote && /^(AI|助手|assistant)$/iu.test(speaker)) return "assistant-reported";
  return "summary";
}

export function normalizeMap(input) {
  const parsed = mapSchema.parse(input);
  const used = new Set();
  const aliases = new Map();
  const ambiguousAliases = new Set();
  const rememberAlias = (alias, id) => {
    if (!alias || ambiguousAliases.has(alias)) return;
    const existing = aliases.get(alias);
    if (existing && existing !== id) {
      aliases.delete(alias);
      ambiguousAliases.add(alias);
      return;
    }
    aliases.set(alias, id);
  };
  const topicDrafts = parsed.topics.map((topic, topicIndex) => {
    const topicId = uniqueId(topic.id || topic.title, `topic-${topicIndex + 1}`, used);
    const nodes = topic.nodes.map((item, nodeIndex) => {
      const rawId = text(item.id);
      const id = uniqueId(rawId || item.title, `${topicId}-${nodeIndex + 1}`, used);
      rememberAlias(id, id);
      rememberAlias(rawId, id);
      rememberAlias(rawId ? baseId(rawId, "") : "", id);
      return {
        id,
        title: text(item.title),
        kind: text(item.kind, "节点"),
        summary: text(item.summary),
        why: text(item.why),
        change: text(item.change),
        quote: text(item.quote),
        speaker: text(item.speaker, "未标注"),
        date: text(item.date),
        evidence: defaultEvidence(item),
        sourceRefs: item.sourceRefs || [],
        rawRelated: item.related ? text(item.related) : null,
      };
    });
    return {
      id: topicId,
      title: text(topic.title),
      description: text(topic.description),
      nodes,
    };
  });
  const resolveRelated = (rawRelated, ownId) => {
    if (!rawRelated) return null;
    for (const alias of [rawRelated, baseId(rawRelated, "")]) {
      if (!alias || ambiguousAliases.has(alias)) continue;
      const resolved = aliases.get(alias);
      if (resolved && resolved !== ownId) return resolved;
    }
    throw new Error(`节点 ${ownId} 的 related 目标 ${rawRelated} 不存在或不唯一。`);
  };
  const topics = topicDrafts.map((topic) => ({
    ...topic,
    nodes: topic.nodes.map(({ rawRelated, ...item }) => ({
      ...item,
      related: resolveRelated(rawRelated, item.id),
    })),
  }));
  return {
    title: text(parsed.title),
    origin: text(parsed.origin),
    kind: text(parsed.kind, "思路起点"),
    description: text(parsed.description),
    compass: text(parsed.compass),
    end: text(parsed.end),
    dateRange: text(parsed.dateRange),
    sourceTask: parsed.sourceTask ? text(parsed.sourceTask) : null,
    topics,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

async function recordedMutation(mapId, mutationId, requestHash) {
  return repository.findMutation(mapId, mutationId, requestHash);
}

function mapStats(map) {
  return {
    topics: map.topics.length,
    nodes: map.topics.reduce((total, topic) => total + topic.nodes.length, 0),
  };
}

function recordSummary(record, status = "ready", extra = {}) {
  return {
    schemaVersion: 2,
    status,
    mapId: record.mapId,
    revision: record.revision,
    title: record.map.title,
    origin: record.map.origin,
    stats: mapStats(record.map),
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    sourceTask: record.map.sourceTask ?? null,
    change: record.change ?? null,
    ...extra,
  };
}

function modelResult(record, {
  includeMap = false,
  withUi = false,
  withWidgetData = withUi,
  status = "ready",
} = {}) {
  const summary = recordSummary(record, status);
  const versionText = status === "created"
    ? `已创建并保存至版本 ${record.revision}`
    : status === "saved"
      ? `已保存至版本 ${record.revision}`
      : `当前为版本 ${record.revision}`;
  const result = {
    structuredContent: includeMap
      ? { ...summary, map: record.map, sourceCheckpoint: record.sourceCheckpoint ?? null }
      : summary,
    content: [{
      type: "text",
      text: `“${record.map.title}”${versionText}（mapId=${record.mapId}，revision=${record.revision}）：${summary.stats.topics} 个主题、${summary.stats.nodes} 个关键节点。起点：${record.map.origin}`,
    }],
  };
  if (withWidgetData) {
    result._meta = {
      widgetData: { ...summary, kind: "map", map: record.map, sourceCheckpoint: record.sourceCheckpoint ?? null },
    };
    if (withUi) {
      result._meta.ui = { resourceUri: UI_URI };
      result._meta["openai/outputTemplate"] = UI_URI;
    }
  }
  return result;
}

function errorResult(error, { withUi = false } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const result = { isError: true, content: [{ type: "text", text: message }] };
  if (withUi) {
    result._meta = {
      ui: { resourceUri: UI_URI },
      "openai/outputTemplate": UI_URI,
      widgetError: message,
    };
  }
  return result;
}

const demoSource = JSON.parse(readFileSync(new URL("../assets/demo-map.json", import.meta.url), "utf8"));
const demoMap = normalizeMap(demoSource);
const demoRecord = {
  mapId: "demo",
  revision: 0,
  createdAt: null,
  updatedAt: null,
  change: null,
  sourceCheckpoint: null,
  map: demoMap,
};
const widgetTemplate = readFileSync(new URL("../assets/context-map-widget.html", import.meta.url), "utf8");
const safeDemoJson = JSON.stringify({ ...recordSummary(demoRecord), kind: "map", map: demoMap, sourceCheckpoint: null })
  .replaceAll("<", "\\u003c");
const widgetHtml = widgetTemplate.replace("/*__SHENDUMAO_DEMO__*/ null", safeDemoJson);
const repository = new MapRepository();

const server = new McpServer(
  { name: "shendumao-context-map", version: VERSION },
  {
    capabilities: { tools: {}, resources: {} },
    instructions: "把对话整理为脉络图时，首次调用 prepare_context_map；已有 mapId 时先读取当前 revision，再用 update_context_map 做增量更新。保留用户原话与原语言；推断必须标作 inference。地图持久保存，写入时必须使用 expectedRevision 防止覆盖。",
  },
);

server.registerResource("context-map-widget", UI_URI, {}, async () => ({
  contents: [{
    uri: UI_URI,
    mimeType: "text/html;profile=mcp-app",
    text: widgetHtml,
    _meta: { ui: { prefersBorder: false } },
  }],
}));

server.registerTool(
  "prepare_context_map",
  {
    title: "新建并保存脉络图",
    description: "校验并持久保存一张已经整理好的对话或规划地图，返回 mapId 与 revision。不会自动读取其他 Codex 任务，也不会改写原文；同一次重试应复用 mutationId。",
    inputSchema: {
      map: mapSchema,
      mutationId: z.string().trim().min(1).max(256),
      sourceCheckpoint: sourceCheckpointSchema.optional(),
      change: changeSchema.optional(),
    },
    outputSchema: summaryOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      ui: { visibility: ["model"] },
      "openai/toolInvocation/invoking": "正在整理并保存脉络…",
      "openai/toolInvocation/invoked": "脉络首版已保存。",
    },
  },
  async ({ map, mutationId, sourceCheckpoint, change }) => {
    try {
      const normalized = normalizeMap(map);
      const selectedChange = change || { kind: "analysis", summary: "建立脉络图首版" };
      const requestHash = hashRequest({ map: normalized, sourceCheckpoint, change: selectedChange });
      const record = await repository.create(normalized, {
        mutationId,
        requestHash,
        change: selectedChange,
        ...(sourceCheckpoint !== undefined ? { sourceCheckpoint } : {}),
      });
      return modelResult(record, { status: "created" });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "update_context_map",
  {
    title: "增量更新脉络图",
    description: "对持久地图原子应用一批语义操作并保存为新 revision。适合对话继续生长、图内手工编辑、节点移动和删改；必须提供读取时看到的 expectedRevision。",
    inputSchema: {
      mapId: z.string().trim().min(1),
      expectedRevision: z.number().int().positive(),
      mutationId: z.string().trim().min(1).max(256),
      operations: z.array(operationSchema).min(1).max(100),
      sourceCheckpoint: sourceCheckpointSchema.optional(),
      change: changeSchema,
    },
    outputSchema: fullOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    _meta: {
      ui: { visibility: ["model", "app"] },
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "正在保存脉络更新…",
      "openai/toolInvocation/invoked": "脉络更新已保存。",
    },
  },
  async ({ mapId, expectedRevision, mutationId, operations, sourceCheckpoint, change }) => {
    try {
      const requestHash = hashRequest({ mapId, expectedRevision, operations, sourceCheckpoint, change });
      const priorResult = await recordedMutation(mapId, mutationId, requestHash);
      if (priorResult) return modelResult(priorResult, { includeMap: true, withWidgetData: true, status: "saved" });
      const current = await repository.get(mapId);
      const updatedMap = normalizedMapSchema.parse(applyMapOperations(current.map, operations));
      const record = await repository.update(mapId, updatedMap, {
        expectedRevision,
        mutationId,
        requestHash,
        change,
        ...(sourceCheckpoint !== undefined ? { sourceCheckpoint } : {}),
      });
      return modelResult(record, { includeMap: true, withWidgetData: true, status: "saved" });
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        try {
          const current = await repository.get(mapId);
          const result = modelResult(current, { includeMap: true, withWidgetData: true, status: "conflict" });
          result.structuredContent.expectedRevision = expectedRevision;
          result.content[0].text = `${error.message}（mapId=${mapId}，当前 revision=${current.revision}）`;
          return result;
        } catch (readError) {
          return errorResult(readError);
        }
      }
      if (error instanceof MapOperationError) {
        return errorResult(new Error(`第 ${error.operationIndex + 1} 个更新操作无效（${error.code}）：${error.message}`));
      }
      if (error instanceof IdempotencyKeyReuseError) return errorResult(error);
      return errorResult(error);
    }
  },
);

server.registerTool(
  "get_context_map",
  {
    title: "读取脉络图",
    description: "按 mapId 读取持久保存的完整脉络；可指定 revision 回看历史，省略时读取最新版。",
    inputSchema: { mapId: z.string().trim().min(1), revision: z.number().int().positive().optional() },
    outputSchema: fullOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
  },
  async ({ mapId, revision }) => {
    try {
      const record = await repository.get(mapId, revision);
      return modelResult(record, { includeMap: true });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "list_context_maps",
  {
    title: "列出已保存的脉络图",
    description: "列出本机持久保存的脉络图摘要，按最近更新时间倒序，不返回完整节点正文。",
    inputSchema: { limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().nonnegative().default(0) },
    outputSchema: { schemaVersion: z.literal(2), maps: z.array(recordSummaryObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ limit, offset }) => {
    try {
      const records = await repository.list({ limit, offset });
      const maps = records.map((record) => recordSummary(record));
      return {
        structuredContent: { schemaVersion: 2, maps },
        content: [{
          type: "text",
          text: [
            `本页找到 ${maps.length} 张已保存的脉络图（offset=${offset}，limit=${limit}）。`,
            ...maps.map((map) => `${map.mapId}  revision=${map.revision}  ${map.stats.topics} 主题/${map.stats.nodes} 节点  ${map.updatedAt ?? "无日期"}  “${map.title}”`),
          ].join("\n"),
        }],
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "list_context_map_revisions",
  {
    title: "查看脉络图版本历史",
    description: "列出一张脉络图的历史 revision、更新时间和修改原因，用于回看当时为什么改变。",
    inputSchema: {
      mapId: z.string().trim().min(1),
      limit: z.number().int().min(1).max(100).default(30),
      offset: z.number().int().nonnegative().default(0),
      order: z.enum(["asc", "desc"]).default("desc"),
    },
    outputSchema: { schemaVersion: z.literal(2), mapId: z.string(), revisions: z.array(recordSummaryObject) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ mapId, limit, offset, order }) => {
    try {
      const records = await repository.listRevisions(mapId, { limit, offset, order });
      const revisions = records.map((record) => recordSummary(record));
      return {
        structuredContent: { schemaVersion: 2, mapId, revisions },
        content: [{ type: "text", text: `“${records.at(-1)?.map.title || mapId}”共有 ${revisions.length} 条版本记录。` }],
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "render_context_map",
  {
    title: "打开脉络图",
    description: "用神都猫脉络交互画布展示持久地图，可指定历史 revision；省略 mapId 时打开只读演示。",
    inputSchema: { mapId: z.string().trim().min(1).optional(), revision: z.number().int().positive().optional() },
    outputSchema: fullOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      ui: { resourceUri: UI_URI, visibility: ["model"] },
      "openai/outputTemplate": UI_URI,
      "openai/toolInvocation/invoking": "正在打开脉络图…",
      "openai/toolInvocation/invoked": "脉络图已打开。",
    },
  },
  async ({ mapId = "demo", revision }) => {
    if (mapId === "demo") return modelResult(demoRecord, { includeMap: true, withUi: true });
    try {
      const record = await repository.get(mapId, revision);
      return modelResult(record, { includeMap: true, withUi: true });
    } catch (error) {
      return errorResult(error, { withUi: true });
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
