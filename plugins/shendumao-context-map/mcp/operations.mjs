const MAX_TOPICS = 12;
const MAX_NODES_PER_TOPIC = 24;

const MAP_PATCH_FIELDS = new Set([
  "title",
  "origin",
  "kind",
  "description",
  "compass",
  "end",
  "dateRange",
  "sourceTask",
]);
const TOPIC_PATCH_FIELDS = new Set(["title", "description"]);
const NODE_PATCH_FIELDS = new Set([
  "title",
  "kind",
  "summary",
  "why",
  "change",
  "quote",
  "speaker",
  "date",
  "related",
  "evidence",
  "sourceRefs",
]);
const EVIDENCE_KINDS = new Set(["user-stated", "assistant-reported", "summary", "inference", "manual"]);

export class MapOperationError extends Error {
  constructor(operationIndex, code, message, details = {}) {
    super(message);
    this.name = "MapOperationError";
    this.operationIndex = operationIndex;
    this.code = code;
    this.details = details;
  }
}

function clone(value) {
  return structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function context(operationIndex) {
  return {
    operationIndex,
    fail(code, message, details = {}) {
      throw new MapOperationError(operationIndex, code, message, details);
    },
  };
}

function assertString(value, {
  ctx,
  path,
  min = 0,
  max,
  nullable = false,
}) {
  if (nullable && value === null) return;
  if (typeof value !== "string") {
    ctx.fail("INVALID_MAP", `${path} 必须是字符串${nullable ? "或 null" : ""}。`, { path });
  }
  if (value !== value.trim()) {
    ctx.fail("INVALID_MAP", `${path} 必须已经完成首尾空白规范化。`, { path });
  }
  if (value.length < min || (max !== undefined && value.length > max)) {
    ctx.fail("INVALID_MAP", `${path} 长度不符合规范。`, { path, min, max, actual: value.length });
  }
}

function assertId(value, ctx, path) {
  assertString(value, { ctx, path, min: 1, max: 96 });
}

function validateNode(node, ctx, path) {
  if (!isObject(node)) ctx.fail("INVALID_MAP", `${path} 必须是对象。`, { path });
  assertId(node.id, ctx, `${path}.id`);
  assertString(node.title, { ctx, path: `${path}.title`, min: 1, max: 240 });
  assertString(node.kind, { ctx, path: `${path}.kind`, max: 80 });
  assertString(node.summary, { ctx, path: `${path}.summary`, max: 1200 });
  assertString(node.why, { ctx, path: `${path}.why`, max: 2000 });
  assertString(node.change, { ctx, path: `${path}.change`, max: 2000 });
  assertString(node.quote, { ctx, path: `${path}.quote`, max: 4000 });
  assertString(node.speaker, { ctx, path: `${path}.speaker`, max: 80 });
  assertString(node.date, { ctx, path: `${path}.date`, max: 32 });
  assertString(node.related, { ctx, path: `${path}.related`, min: 1, max: 96, nullable: true });
  if (node.evidence !== undefined && !EVIDENCE_KINDS.has(node.evidence)) {
    ctx.fail("INVALID_MAP", `${path}.evidence 不是支持的证据类型。`, { path: `${path}.evidence` });
  }
  if (node.sourceRefs !== undefined) {
    if (!Array.isArray(node.sourceRefs) || node.sourceRefs.length > 8) {
      ctx.fail("INVALID_MAP", `${path}.sourceRefs 必须是不超过 8 项的数组。`, { path: `${path}.sourceRefs` });
    }
    node.sourceRefs.forEach((reference, index) => {
      const refPath = `${path}.sourceRefs[${index}]`;
      if (!isObject(reference)) ctx.fail("INVALID_MAP", `${refPath} 必须是对象。`, { path: refPath });
      for (const [field, maximum] of Object.entries({ taskId: 240, turnId: 160, messageId: 160, date: 40, excerpt: 1200 })) {
        if (reference[field] !== undefined) assertString(reference[field], { ctx, path: `${refPath}.${field}`, max: maximum });
      }
      if (reference.role !== undefined && !["user", "assistant", "tool", "mixed"].includes(reference.role)) {
        ctx.fail("INVALID_MAP", `${refPath}.role 不是支持的角色。`, { path: `${refPath}.role` });
      }
    });
  }
}

function validateTopic(topic, ctx, path) {
  if (!isObject(topic)) ctx.fail("INVALID_MAP", `${path} 必须是对象。`, { path });
  assertId(topic.id, ctx, `${path}.id`);
  assertString(topic.title, { ctx, path: `${path}.title`, min: 1, max: 240 });
  assertString(topic.description, { ctx, path: `${path}.description`, max: 1200 });
  if (!Array.isArray(topic.nodes)) {
    ctx.fail("INVALID_MAP", `${path}.nodes 必须是数组。`, { path: `${path}.nodes` });
  }
  if (topic.nodes.length > MAX_NODES_PER_TOPIC) {
    ctx.fail("TOO_MANY_NODES", `${topic.id} 中的节点不能超过 ${MAX_NODES_PER_TOPIC} 个。`, {
      topicId: topic.id,
      maximum: MAX_NODES_PER_TOPIC,
    });
  }
  topic.nodes.forEach((node, index) => validateNode(node, ctx, `${path}.nodes[${index}]`));
}

function validateMap(map, ctx) {
  if (!isObject(map)) ctx.fail("INVALID_MAP", "地图必须是对象。");
  assertString(map.title, { ctx, path: "map.title", min: 1, max: 240 });
  assertString(map.origin, { ctx, path: "map.origin", min: 1, max: 400 });
  assertString(map.kind, { ctx, path: "map.kind", max: 80 });
  assertString(map.description, { ctx, path: "map.description", max: 1600 });
  assertString(map.compass, { ctx, path: "map.compass", max: 800 });
  assertString(map.end, { ctx, path: "map.end", max: 400 });
  assertString(map.dateRange, { ctx, path: "map.dateRange", max: 64 });
  assertString(map.sourceTask, { ctx, path: "map.sourceTask", max: 400, nullable: true });

  if (!Array.isArray(map.topics)) ctx.fail("INVALID_MAP", "map.topics 必须是数组。", { path: "map.topics" });
  if (map.topics.length < 1) ctx.fail("LAST_TOPIC", "地图必须至少保留一个主题。");
  if (map.topics.length > MAX_TOPICS) {
    ctx.fail("TOO_MANY_TOPICS", `地图不能超过 ${MAX_TOPICS} 个主题。`, { maximum: MAX_TOPICS });
  }

  const topicIds = new Set();
  const nodeIds = new Set();
  const nodes = [];
  map.topics.forEach((topic, topicIndex) => {
    validateTopic(topic, ctx, `map.topics[${topicIndex}]`);
    if (topicIds.has(topic.id)) {
      ctx.fail("DUPLICATE_TOPIC_ID", `主题 ID ${topic.id} 重复。`, { topicId: topic.id });
    }
    topicIds.add(topic.id);
    topic.nodes.forEach((node) => {
      if (nodeIds.has(node.id)) {
        ctx.fail("DUPLICATE_NODE_ID", `节点 ID ${node.id} 在全图中重复。`, { nodeId: node.id });
      }
      nodeIds.add(node.id);
      nodes.push(node);
    });
  });

  for (const node of nodes) {
    if (node.related === null) continue;
    if (node.related === node.id) {
      ctx.fail("SELF_RELATION", `节点 ${node.id} 不能关联自身。`, { nodeId: node.id });
    }
    if (!nodeIds.has(node.related)) {
      ctx.fail("RELATED_NODE_NOT_FOUND", `节点 ${node.id} 的关联目标 ${node.related} 不存在。`, {
        nodeId: node.id,
        related: node.related,
      });
    }
  }
}

function requireObject(value, ctx, path) {
  if (!isObject(value)) ctx.fail("INVALID_OPERATION", `${path} 必须是对象。`, { path });
  return value;
}

function requireId(value, ctx, path) {
  if (typeof value !== "string" || value.length === 0) {
    ctx.fail("INVALID_OPERATION", `${path} 必须是非空字符串。`, { path });
  }
  return value;
}

function assertPatch(patch, fields, ctx, path) {
  requireObject(patch, ctx, path);
  const keys = Object.keys(patch);
  if (keys.length === 0) ctx.fail("INVALID_PATCH", `${path} 不能为空。`, { path });
  const unknown = keys.find((key) => !fields.has(key));
  if (unknown) {
    ctx.fail("UNKNOWN_PATCH_FIELD", `${path}.${unknown} 不可修改。`, { path: `${path}.${unknown}` });
  }
}

function findTopic(map, topicId, ctx) {
  const index = map.topics.findIndex((topic) => topic.id === topicId);
  if (index < 0) ctx.fail("TOPIC_NOT_FOUND", `主题 ${topicId} 不存在。`, { topicId });
  return { topic: map.topics[index], index };
}

function findNode(map, nodeId, ctx) {
  for (let topicIndex = 0; topicIndex < map.topics.length; topicIndex += 1) {
    const nodeIndex = map.topics[topicIndex].nodes.findIndex((node) => node.id === nodeId);
    if (nodeIndex >= 0) {
      return {
        node: map.topics[topicIndex].nodes[nodeIndex],
        nodeIndex,
        topic: map.topics[topicIndex],
        topicIndex,
      };
    }
  }
  ctx.fail("NODE_NOT_FOUND", `节点 ${nodeId} 不存在。`, { nodeId });
}

function insertionIndex(items, afterId, ctx, {
  entity,
  idKey = "id",
}) {
  if (afterId === undefined) return items.length;
  if (afterId === null) return 0;
  requireId(afterId, ctx, `after${entity}Id`);
  const anchorIndex = items.findIndex((item) => item[idKey] === afterId);
  if (anchorIndex < 0) {
    ctx.fail(`${entity.toUpperCase()}_ANCHOR_NOT_FOUND`, `${entity === "topic" ? "主题" : "节点"}锚点 ${afterId} 不存在。`, {
      [`after${entity[0].toUpperCase()}${entity.slice(1)}Id`]: afterId,
    });
  }
  return anchorIndex + 1;
}

function incomingRelations(map, deletedNodeIds) {
  const incoming = [];
  for (const topic of map.topics) {
    for (const node of topic.nodes) {
      if (!deletedNodeIds.has(node.id) && deletedNodeIds.has(node.related)) incoming.push(node);
    }
  }
  return incoming;
}

function removeOrRejectIncoming(map, deletedNodeIds, operation, ctx) {
  const incoming = incomingRelations(map, deletedNodeIds);
  if (!incoming.length) return;
  if (operation.removeIncomingRelations !== true) {
    ctx.fail("NODE_REFERENCED", "要删除的节点仍被其他节点关联。", {
      deletedNodeIds: [...deletedNodeIds],
      referencingNodeIds: incoming.map((node) => node.id),
    });
  }
  for (const node of incoming) node.related = null;
}

function setMap(map, operation, ctx) {
  assertPatch(operation.patch, MAP_PATCH_FIELDS, ctx, "patch");
  Object.assign(map, operation.patch);
}

function addTopic(map, operation, ctx) {
  requireObject(operation.topic, ctx, "topic");
  const topic = clone(operation.topic);
  const insertAt = insertionIndex(map.topics, operation.afterTopicId, ctx, { entity: "topic" });
  map.topics.splice(insertAt, 0, topic);
}

function updateTopic(map, operation, ctx) {
  const topicId = requireId(operation.topicId, ctx, "topicId");
  const { topic } = findTopic(map, topicId, ctx);
  assertPatch(operation.patch, TOPIC_PATCH_FIELDS, ctx, "patch");
  Object.assign(topic, operation.patch);
}

function moveTopic(map, operation, ctx) {
  const topicId = requireId(operation.topicId, ctx, "topicId");
  const { index } = findTopic(map, topicId, ctx);
  if (operation.afterTopicId === topicId) return;
  const [topic] = map.topics.splice(index, 1);
  const insertAt = insertionIndex(map.topics, operation.afterTopicId, ctx, { entity: "topic" });
  map.topics.splice(insertAt, 0, topic);
}

function deleteTopic(map, operation, ctx) {
  const topicId = requireId(operation.topicId, ctx, "topicId");
  const { topic, index } = findTopic(map, topicId, ctx);
  if (map.topics.length === 1) ctx.fail("LAST_TOPIC", "地图必须至少保留一个主题。", { topicId });
  const deletedNodeIds = new Set(topic.nodes.map((node) => node.id));
  removeOrRejectIncoming(map, deletedNodeIds, operation, ctx);
  map.topics.splice(index, 1);
}

function addNode(map, operation, ctx) {
  const topicId = requireId(operation.topicId, ctx, "topicId");
  const { topic } = findTopic(map, topicId, ctx);
  requireObject(operation.node, ctx, "node");
  const node = clone(operation.node);
  const insertAt = insertionIndex(topic.nodes, operation.afterNodeId, ctx, { entity: "node" });
  topic.nodes.splice(insertAt, 0, node);
}

function updateNode(map, operation, ctx) {
  const nodeId = requireId(operation.nodeId, ctx, "nodeId");
  const { node } = findNode(map, nodeId, ctx);
  assertPatch(operation.patch, NODE_PATCH_FIELDS, ctx, "patch");
  Object.assign(node, operation.patch);
}

function moveNode(map, operation, ctx) {
  const nodeId = requireId(operation.nodeId, ctx, "nodeId");
  const topicId = requireId(operation.topicId, ctx, "topicId");
  const source = findNode(map, nodeId, ctx);
  const target = findTopic(map, topicId, ctx).topic;
  if (source.topic === target && operation.afterNodeId === nodeId) return;
  source.topic.nodes.splice(source.nodeIndex, 1);
  const insertAt = insertionIndex(target.nodes, operation.afterNodeId, ctx, { entity: "node" });
  target.nodes.splice(insertAt, 0, source.node);
}

function deleteNode(map, operation, ctx) {
  const nodeId = requireId(operation.nodeId, ctx, "nodeId");
  const found = findNode(map, nodeId, ctx);
  removeOrRejectIncoming(map, new Set([nodeId]), operation, ctx);
  found.topic.nodes.splice(found.nodeIndex, 1);
}

const handlers = {
  set_map: setMap,
  add_topic: addTopic,
  update_topic: updateTopic,
  move_topic: moveTopic,
  delete_topic: deleteTopic,
  add_node: addNode,
  update_node: updateNode,
  move_node: moveNode,
  delete_node: deleteNode,
};

/**
 * Atomically applies semantic operations to an already-normalized context map.
 * The input map and operation payloads are never mutated. Omitting an `after*Id`
 * appends; `null` inserts first; a string inserts immediately after that ID.
 */
export function applyMapOperations(currentMap, operations) {
  if (!Array.isArray(operations)) {
    throw new MapOperationError(-1, "INVALID_OPERATIONS", "operations 必须是数组。");
  }

  let draft;
  try {
    draft = clone(currentMap);
  } catch (error) {
    throw new MapOperationError(-1, "INVALID_MAP", "地图必须是可复制的纯数据对象。", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  validateMap(draft, context(-1));

  operations.forEach((operation, operationIndex) => {
    const ctx = context(operationIndex);
    try {
      requireObject(operation, ctx, `operations[${operationIndex}]`);
      const handler = handlers[operation.type];
      if (!handler) {
        ctx.fail("UNKNOWN_OPERATION", `不支持操作 ${String(operation.type)}。`, { type: operation.type });
      }
      handler(draft, operation, ctx);
      validateMap(draft, ctx);
    } catch (error) {
      if (error instanceof MapOperationError) throw error;
      throw new MapOperationError(operationIndex, "OPERATION_FAILED", "操作数据无法安全应用。", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return draft;
}
