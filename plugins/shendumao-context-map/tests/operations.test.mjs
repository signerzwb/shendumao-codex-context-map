import assert from "node:assert/strict";
import test from "node:test";
import { applyMapOperations, MapOperationError } from "../mcp/operations.mjs";

function node(id, overrides = {}) {
  return {
    id,
    title: `节点 ${id}`,
    kind: "节点",
    summary: "",
    why: "",
    change: "",
    quote: "",
    speaker: "未标注",
    date: "",
    related: null,
    ...overrides,
  };
}

function topic(id, nodes = [], overrides = {}) {
  return {
    id,
    title: `主题 ${id}`,
    description: "",
    nodes,
    ...overrides,
  };
}

function map(overrides = {}) {
  return {
    title: "测试脉络",
    origin: "测试起点",
    kind: "思路起点",
    description: "",
    compass: "",
    end: "",
    dateRange: "",
    sourceTask: null,
    topics: [
      topic("alpha", [node("a1"), node("a2")]),
      topic("beta", [node("b1")]),
    ],
    ...overrides,
  };
}

function expectOperationError(run, { operationIndex, code }) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof MapOperationError);
    assert.equal(error.operationIndex, operationIndex);
    assert.equal(error.code, code);
    return true;
  });
}

test("原子应用地图、主题和节点操作，并保持原输入不变", () => {
  const input = map();
  const snapshot = structuredClone(input);
  const newTopic = topic("gamma", [node("g1")]);
  const newNode = node("a0");
  const operations = [
    { type: "set_map", patch: { title: "更新后的脉络", sourceTask: "codex://threads/example" } },
    { type: "add_topic", topic: newTopic, afterTopicId: null },
    { type: "update_topic", topicId: "beta", patch: { title: "第二主题" } },
    { type: "move_topic", topicId: "beta", afterTopicId: "gamma" },
    { type: "add_node", topicId: "alpha", node: newNode, afterNodeId: null },
    { type: "update_node", nodeId: "a2", patch: { title: "已更新", related: "g1" } },
    { type: "move_node", nodeId: "a1", topicId: "beta", afterNodeId: null },
    { type: "delete_node", nodeId: "b1" },
    { type: "delete_topic", topicId: "alpha", removeIncomingRelations: true },
  ];

  const result = applyMapOperations(input, operations);

  assert.deepEqual(input, snapshot);
  assert.notEqual(result, input);
  assert.notEqual(result.topics, input.topics);
  assert.deepEqual(result.topics.map((item) => item.id), ["gamma", "beta"]);
  assert.equal(result.title, "更新后的脉络");
  assert.equal(result.sourceTask, "codex://threads/example");
  assert.equal(result.topics[1].title, "第二主题");
  assert.deepEqual(result.topics[1].nodes.map((item) => item.id), ["a1"]);
  assert.deepEqual(newTopic, topic("gamma", [node("g1")]));
  assert.deepEqual(newNode, node("a0"));
});

test("null 插到最前，省略 afterId 追加到最后", () => {
  const result = applyMapOperations(map(), [
    { type: "add_topic", topic: topic("last") },
    { type: "add_topic", topic: topic("first"), afterTopicId: null },
    { type: "add_node", topicId: "beta", node: node("b-last") },
    { type: "add_node", topicId: "beta", node: node("b-first"), afterNodeId: null },
    { type: "move_topic", topicId: "alpha", afterTopicId: "last" },
    { type: "move_node", nodeId: "b1", topicId: "beta" },
  ]);

  assert.deepEqual(result.topics.map((item) => item.id), ["first", "beta", "last", "alpha"]);
  assert.deepEqual(result.topics[1].nodes.map((item) => item.id), ["b-first", "b-last", "b1"]);
});

test("节点 ID 在全图唯一，失败操作带准确的索引与错误码", () => {
  const input = map();
  const snapshot = structuredClone(input);
  expectOperationError(
    () => applyMapOperations(input, [
      { type: "set_map", patch: { compass: "先成功" } },
      { type: "add_node", topicId: "beta", node: node("a1") },
    ]),
    { operationIndex: 1, code: "DUPLICATE_NODE_ID" },
  );
  assert.deepEqual(input, snapshot);
});

test("related 必须指向存在的其他节点", () => {
  expectOperationError(
    () => applyMapOperations(map(), [
      { type: "update_node", nodeId: "a1", patch: { related: "missing" } },
    ]),
    { operationIndex: 0, code: "RELATED_NODE_NOT_FOUND" },
  );
  expectOperationError(
    () => applyMapOperations(map(), [
      { type: "update_node", nodeId: "a1", patch: { related: "a1" } },
    ]),
    { operationIndex: 0, code: "SELF_RELATION" },
  );
});

test("默认拒绝删除被引用节点，显式请求后清除入向关联", () => {
  const input = map({
    topics: [
      topic("alpha", [node("a1")]),
      topic("beta", [node("b1", { related: "a1" })]),
    ],
  });
  expectOperationError(
    () => applyMapOperations(input, [{ type: "delete_node", nodeId: "a1" }]),
    { operationIndex: 0, code: "NODE_REFERENCED" },
  );

  const result = applyMapOperations(input, [
    { type: "delete_node", nodeId: "a1", removeIncomingRelations: true },
  ]);
  assert.equal(result.topics[1].nodes[0].related, null);
  assert.equal(result.topics[0].nodes.length, 0);
  assert.equal(input.topics[1].nodes[0].related, "a1");
});

test("删除主题同样保护跨主题关联，并始终保留根主题", () => {
  const input = map({
    topics: [
      topic("alpha", [node("a1")]),
      topic("beta", [node("b1", { related: "a1" })]),
    ],
  });
  expectOperationError(
    () => applyMapOperations(input, [{ type: "delete_topic", topicId: "alpha" }]),
    { operationIndex: 0, code: "NODE_REFERENCED" },
  );
  const result = applyMapOperations(input, [
    { type: "delete_topic", topicId: "alpha", removeIncomingRelations: true },
  ]);
  assert.deepEqual(result.topics.map((item) => item.id), ["beta"]);
  assert.equal(result.topics[0].nodes[0].related, null);

  expectOperationError(
    () => applyMapOperations(result, [{ type: "delete_topic", topicId: "beta" }]),
    { operationIndex: 0, code: "LAST_TOPIC" },
  );
});

test("移动节点必须指定存在的目标主题和该主题内的锚点", () => {
  expectOperationError(
    () => applyMapOperations(map(), [
      { type: "move_node", nodeId: "a1", topicId: "missing", afterNodeId: null },
    ]),
    { operationIndex: 0, code: "TOPIC_NOT_FOUND" },
  );
  expectOperationError(
    () => applyMapOperations(map(), [
      { type: "move_node", nodeId: "a1", topicId: "beta", afterNodeId: "a2" },
    ]),
    { operationIndex: 0, code: "NODE_ANCHOR_NOT_FOUND" },
  );
});

test("更新不允许绕过语义操作修改 ID、节点数组或主题数组", () => {
  expectOperationError(
    () => applyMapOperations(map(), [{ type: "update_node", nodeId: "a1", patch: { id: "renamed" } }]),
    { operationIndex: 0, code: "UNKNOWN_PATCH_FIELD" },
  );
  expectOperationError(
    () => applyMapOperations(map(), [{ type: "update_topic", topicId: "alpha", patch: { nodes: [] } }]),
    { operationIndex: 0, code: "UNKNOWN_PATCH_FIELD" },
  );
  expectOperationError(
    () => applyMapOperations(map(), [{ type: "set_map", patch: { topics: [] } }]),
    { operationIndex: 0, code: "UNKNOWN_PATCH_FIELD" },
  );
});

test("不会 normalize 或自动改写新增 ID", () => {
  const result = applyMapOperations(map(), [
    { type: "add_node", topicId: "alpha", node: node("Exact_ID 01") },
  ]);
  assert.equal(result.topics[0].nodes.at(-1).id, "Exact_ID 01");

  expectOperationError(
    () => applyMapOperations(map(), [
      { type: "add_node", topicId: "alpha", node: node(" spaced ") },
    ]),
    { operationIndex: 0, code: "INVALID_MAP" },
  );
});

test("证据类型与来源引用可以增量更新并保持原文", () => {
  const result = applyMapOperations(map(), [{
    type: "update_node",
    nodeId: "a1",
    patch: {
      evidence: "user-stated",
      sourceRefs: [{ taskId: "task-中文", turnId: "turn-8", role: "user", excerpt: "不要改写这句话。" }],
    },
  }]);
  assert.equal(result.topics[0].nodes[0].evidence, "user-stated");
  assert.equal(result.topics[0].nodes[0].sourceRefs[0].excerpt, "不要改写这句话。");
  expectOperationError(
    () => applyMapOperations(result, [{ type: "update_node", nodeId: "a1", patch: { evidence: "guess" } }]),
    { operationIndex: 0, code: "INVALID_MAP" },
  );
});

test("无法复制的操作数据也统一包装为带索引的 MapOperationError", () => {
  expectOperationError(
    () => applyMapOperations(map(), [
      { type: "add_node", topicId: "alpha", node: { ...node("bad"), unsupported: () => {} } },
    ]),
    { operationIndex: 0, code: "OPERATION_FAILED" },
  );
});
