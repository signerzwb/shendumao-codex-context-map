import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  IdempotencyKeyReuseError,
  MapNotFoundError,
  MapRepository,
  RevisionConflictError,
  resolveDataRoot,
} from "../mcp/storage.mjs";

async function withTemporaryRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "shendumao-storage-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("数据目录按显式配置、Codex 目录和各平台约定依次解析", () => {
  assert.equal(resolveDataRoot({
    env: { SHENDUMAO_DATA_DIR: "/explicit/maps", CODEX_HOME: "/codex" },
    platform: "linux",
    home: "/home/tester",
  }), "/explicit/maps");
  assert.equal(resolveDataRoot({
    env: { CODEX_HOME: "/opt/codex" },
    platform: "linux",
    home: "/home/tester",
  }), "/opt/codex/shendumao-context-map");
  assert.equal(resolveDataRoot({
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    platform: "win32",
    home: "C:\\Users\\tester",
  }), "C:\\Users\\tester\\AppData\\Local\\Shendumao\\ContextMap");
  assert.equal(resolveDataRoot({
    env: {},
    platform: "darwin",
    home: "/Users/tester",
  }), "/Users/tester/Library/Application Support/Shendumao/ContextMap");
  assert.equal(resolveDataRoot({
    env: { XDG_DATA_HOME: "/var/data/tester" },
    platform: "linux",
    home: "/home/tester",
  }), "/var/data/tester/shendumao-context-map");
  assert.equal(resolveDataRoot({
    env: {},
    platform: "linux",
    home: "/home/tester",
  }), "/home/tester/.local/share/shendumao-context-map");
});

test("map UUID 校验阻止目录穿越", async () => {
  await withTemporaryRoot(async (root) => {
    const repository = new MapRepository({ root });
    assert.throws(() => repository.mapDirectory("../escape"), MapNotFoundError);
    assert.throws(() => repository.mapDirectory("map-not-a-uuid"), MapNotFoundError);
    await assert.rejects(repository.get("map-00000000-0000-0000-0000-000000000000/../../x"), MapNotFoundError);
  });
});

test("完整 revision 落盘，MCP 进程重启后仍能读取中文原文", async () => {
  await withTemporaryRoot(async (root) => {
    const repository = new MapRepository({
      root,
      now: () => new Date("2026-09-12T06:00:00.000Z"),
    });
    const created = await repository.create(
      { title: "长期脉络", origin: "为什么开始", quote: "不要翻译我的原话：云从龙。" },
      {
        mutationId: "create-restart-case",
        requestHash: "sha256:create-restart-case",
        change: { kind: "create", summary: "从历史对话建立首版" },
        sourceCheckpoint: { taskId: "019ef946-3d45-7823-be99-9409926f13dd", turn: 18 },
      },
    );
    assert.match(created.mapId, /^map-[0-9a-f-]{36}$/);
    assert.equal(created.revision, 1);
    assert.equal(created.map.quote, "不要翻译我的原话：云从龙。");

    const restartedRepository = new MapRepository({ root });
    const restored = await restartedRepository.get(created.mapId);
    assert.deepEqual(restored, created);

    const files = await readdir(restartedRepository.mapDirectory(created.mapId));
    assert.deepEqual(files, ["revision-00000001.json"]);
    const raw = await readFile(join(
      restartedRepository.mapDirectory(created.mapId),
      "revision-00000001.json",
    ), "utf8");
    assert.match(raw, /不要翻译我的原话：云从龙。/);
  });
});

test("create 与 update 的 mutationId/requestHash 可跨重试幂等，并拒绝键复用", async () => {
  await withTemporaryRoot(async (root) => {
    const repository = new MapRepository({ root });
    const createOptions = { mutationId: "create-42", requestHash: "hash-create-42" };
    const first = await repository.create({ title: "首版" }, createOptions);
    const retried = await new MapRepository({ root }).create({ title: "首版" }, createOptions);
    assert.deepEqual(retried, first);
    await assert.rejects(
      repository.create({ title: "不同请求" }, { ...createOptions, requestHash: "another-hash" }),
      (error) => error instanceof IdempotencyKeyReuseError
        && error.mutationId === "create-42"
        && error.revision === 1,
    );

    const second = await repository.update(first.mapId, { title: "第二版" }, {
      expectedRevision: 1,
      mutationId: "update-42",
      requestHash: "hash-update-42",
    });
    const third = await repository.update(first.mapId, { title: "第三版" }, {
      expectedRevision: 2,
      mutationId: "update-43",
      requestHash: "hash-update-43",
    });
    assert.equal(third.revision, 3);

    // A delayed retry returns the original result even though newer revisions exist.
    const delayedRetry = await new MapRepository({ root }).update(first.mapId, { title: "第二版" }, {
      expectedRevision: 1,
      mutationId: "update-42",
      requestHash: "hash-update-42",
    });
    assert.deepEqual(delayedRetry, second);
    await assert.rejects(
      repository.update(first.mapId, { title: "被误复用" }, {
        expectedRevision: 3,
        mutationId: "update-42",
        requestHash: "wrong-hash",
      }),
      IdempotencyKeyReuseError,
    );
  });
});

test("findMutation 扫描超过 100 条的完整历史，不受版本列表分页限制", { timeout: 30_000 }, async () => {
  await withTemporaryRoot(async (root) => {
    const repository = new MapRepository({ root });
    const created = await repository.create({ title: "第 1 版", text: "最早的中文内容" }, {
      mutationId: "oldest-mutation",
      requestHash: "oldest-request-hash",
    });
    let revision = created.revision;
    for (let index = 2; index <= 101; index += 1) {
      const updated = await repository.update(created.mapId, {
        title: `第 ${index} 版`,
        text: `持续生长 ${index}`,
      }, { expectedRevision: revision });
      revision = updated.revision;
    }
    assert.equal(revision, 101);

    const defaultPage = await repository.listRevisions(created.mapId, { order: "desc" });
    assert.equal(defaultPage.length, 100);
    assert.equal(defaultPage.some((record) => record.revision === 1), false);

    const restartedRepository = new MapRepository({ root });
    const found = await restartedRepository.findMutation(
      created.mapId,
      "oldest-mutation",
      "oldest-request-hash",
    );
    assert.equal(found.revision, 1);
    assert.equal(found.map.text, "最早的中文内容");
    assert.equal(await restartedRepository.findMutation(
      created.mapId,
      "never-used",
      "unused-request-hash",
    ), null);
    await assert.rejects(
      restartedRepository.findMutation(created.mapId, "oldest-mutation", "different-request-hash"),
      (error) => error instanceof IdempotencyKeyReuseError
        && error.revision === 1
        && error.existingRequestHash === "oldest-request-hash",
    );
  });
});

test("expectedRevision 阻止覆盖；两个仓库并发更新只有一个成功", async () => {
  await withTemporaryRoot(async (root) => {
    const repository = new MapRepository({ root, lockRetryMs: 2, lockRetries: 100 });
    const created = await repository.create({ title: "版本一" });

    await assert.rejects(
      repository.update(created.mapId, { title: "错误覆盖" }, { expectedRevision: 8 }),
      (error) => error instanceof RevisionConflictError
        && error.expectedRevision === 8
        && error.actualRevision === 1,
    );

    const left = new MapRepository({ root, lockRetryMs: 2, lockRetries: 100 });
    const right = new MapRepository({ root, lockRetryMs: 2, lockRetries: 100 });
    const outcomes = await Promise.allSettled([
      left.update(created.mapId, { title: "并发甲" }, { expectedRevision: 1 }),
      right.update(created.mapId, { title: "并发乙" }, { expectedRevision: 1 }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(rejected.reason instanceof RevisionConflictError);
    assert.equal((await repository.get(created.mapId)).revision, 2);
  });
});

test("历史版本永不物理覆盖，并记录版本原因和来源检查点", async () => {
  await withTemporaryRoot(async (root) => {
    let minute = 0;
    const repository = new MapRepository({
      root,
      now: () => new Date(Date.UTC(2026, 8, 12, 8, minute++)),
    });
    const first = await repository.create({ title: "想法", text: "初心" }, {
      change: { kind: "create", summary: "记录初始想法" },
      sourceCheckpoint: { taskId: "task-cn", throughTurn: 5 },
    });
    const second = await repository.update(first.mapId, { title: "想法", text: "扩展成两个分支" }, {
      expectedRevision: 1,
      change: { kind: "grow", summary: "新增实现与验证分支" },
    });
    const third = await repository.update(first.mapId, { title: "想法", text: "归档" }, {
      expectedRevision: 2,
      sourceCheckpoint: null,
    });

    assert.deepEqual(second.sourceCheckpoint, first.sourceCheckpoint);
    assert.equal(third.sourceCheckpoint, null);
    assert.equal(third.change, null);
    const history = await repository.listRevisions(first.mapId);
    assert.deepEqual(history.map((record) => record.revision), [1, 2, 3]);
    assert.deepEqual(history.map((record) => record.map.text), ["初心", "扩展成两个分支", "归档"]);
    assert.deepEqual((await repository.listRevisions(first.mapId, { order: "desc", limit: 2 }))
      .map((record) => record.revision), [3, 2]);

    const files = await readdir(repository.mapDirectory(first.mapId));
    assert.deepEqual(files.sort(), [
      "revision-00000001.json",
      "revision-00000002.json",
      "revision-00000003.json",
    ]);
    const listed = await repository.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].revision, 3);
  });
});

test("崩溃遗留的陈旧锁经身份复核后恢复，不删除 revision 历史", async () => {
  await withTemporaryRoot(async (root) => {
    const initialRepository = new MapRepository({ root });
    const created = await initialRepository.create({ title: "锁恢复前" });
    const lockPath = join(initialRepository.mapDirectory(created.mapId), ".write.lock");
    await mkdir(lockPath);
    const oldInstant = "2020-01-01T00:00:00.000Z";
    const ownerPath = join(lockPath, "owner.json");
    await writeFile(ownerPath, `${JSON.stringify({
      token: "dead-process-token",
      pid: 999999,
      acquiredAt: oldInstant,
      heartbeatAt: oldInstant,
    })}\n`, "utf8");
    const oldDate = new Date(oldInstant);
    await utimes(lockPath, oldDate, oldDate);
    await utimes(ownerPath, oldDate, oldDate);

    const recoveredRepository = new MapRepository({
      root,
      lockStaleMs: 50,
      lockRetryMs: 2,
      lockRetries: 20,
    });
    const updated = await recoveredRepository.update(created.mapId, { title: "锁恢复后" }, {
      expectedRevision: 1,
    });
    assert.equal(updated.revision, 2);
    assert.deepEqual((await recoveredRepository.listRevisions(created.mapId))
      .map((record) => record.map.title), ["锁恢复前", "锁恢复后"]);
    assert.equal((await readdir(recoveredRepository.mapDirectory(created.mapId)))
      .some((name) => name.includes(".write.lock")), false);
  });
});
