import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";

const RECORD_FORMAT = "shendumao-context-map-record";
const RECORD_SCHEMA_VERSION = 2;
const MAP_ID_PATTERN = /^map-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVISION_FILE_PATTERN = /^revision-(\d{8})\.json$/;
const DEFAULT_LOCK_STALE_MS = 60_000;
const DEFAULT_LOCK_RETRY_MS = 35;
const DEFAULT_LOCK_RETRIES = 400;

export class MapNotFoundError extends Error {
  constructor(mapId, revision = undefined) {
    const suffix = revision === undefined ? "" : ` 的版本 ${revision}`;
    super(`没有找到地图 ${mapId}${suffix}。`);
    this.name = "MapNotFoundError";
    this.mapId = mapId;
    this.revision = revision;
  }
}

export class RevisionConflictError extends Error {
  constructor(mapId, expectedRevision, actualRevision) {
    super(`地图 ${mapId} 已更新：期望版本 ${expectedRevision}，当前版本 ${actualRevision}。请重新读取后再保存。`);
    this.name = "RevisionConflictError";
    this.mapId = mapId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class IdempotencyKeyReuseError extends Error {
  constructor({ mapId, mutationId, existingRequestHash, receivedRequestHash, revision }) {
    super(`幂等键 ${mutationId} 已用于另一份请求，不能在地图 ${mapId} 上重复使用。`);
    this.name = "IdempotencyKeyReuseError";
    this.mapId = mapId;
    this.mutationId = mutationId;
    this.existingRequestHash = existingRequestHash;
    this.receivedRequestHash = receivedRequestHash;
    this.revision = revision;
  }
}

/** Resolve the user-data directory without depending on the process cwd. */
export function resolveDataRoot({
  env = process.env,
  platform = process.platform,
  home = homedir(),
} = {}) {
  const pathApi = platform === "win32" ? win32 : posix;
  if (env.SHENDUMAO_DATA_DIR) return pathApi.resolve(env.SHENDUMAO_DATA_DIR);
  if (env.CODEX_HOME) return pathApi.resolve(env.CODEX_HOME, "shendumao-context-map");

  if (platform === "win32") {
    const base = env.LOCALAPPDATA || env.APPDATA || win32.join(home, "AppData", "Local");
    return win32.resolve(base, "Shendumao", "ContextMap");
  }
  if (platform === "darwin") {
    return posix.resolve(home, "Library", "Application Support", "Shendumao", "ContextMap");
  }
  const base = env.XDG_DATA_HOME || posix.join(home, ".local", "share");
  return posix.resolve(base, "shendumao-context-map");
}

function assertMapId(mapId) {
  if (typeof mapId !== "string" || !MAP_ID_PATTERN.test(mapId)) {
    throw new MapNotFoundError(String(mapId));
  }
  return mapId.toLowerCase();
}

function assertRevision(revision, label = "revision") {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 99_999_999) {
    throw new TypeError(`${label} 必须是 1 到 99999999 之间的整数。`);
  }
  return revision;
}

function revisionFileName(revision) {
  return `revision-${String(assertRevision(revision)).padStart(8, "0")}.json`;
}

function cloneJson(value, label) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} 必须是可序列化的 JSON：${error.message}`);
  }
  if (serialized === undefined) throw new TypeError(`${label} 必须是可序列化的 JSON。`);
  return JSON.parse(serialized);
}

function normalizeMap(map) {
  const result = cloneJson(map, "map");
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("map 必须是 JSON 对象。");
  }
  return result;
}

function normalizeChange(change) {
  if (change == null) return null;
  if (typeof change !== "object" || Array.isArray(change)) {
    throw new TypeError("change 必须是 { kind, summary } 或 null。");
  }
  const kind = typeof change.kind === "string" ? change.kind.trim() : "";
  const summary = typeof change.summary === "string" ? change.summary.trim() : "";
  if (!kind || !summary) throw new TypeError("change.kind 和 change.summary 必须是非空字符串。");
  return { kind, summary };
}

function normalizeSourceCheckpoint(sourceCheckpoint) {
  if (sourceCheckpoint == null) return null;
  const result = cloneJson(sourceCheckpoint, "sourceCheckpoint");
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("sourceCheckpoint 必须是 JSON 对象或 null。");
  }
  return result;
}

function normalizeMutationOptions({ mutationId, requestHash } = {}) {
  const hasMutationId = mutationId !== undefined && mutationId !== null;
  const hasRequestHash = requestHash !== undefined && requestHash !== null;
  if (hasMutationId !== hasRequestHash) {
    throw new TypeError("mutationId 与 requestHash 必须同时提供，或同时省略。");
  }
  if (!hasMutationId) return { mutationId: null, requestHash: null };
  if (typeof mutationId !== "string" || !mutationId.trim() || mutationId.length > 256) {
    throw new TypeError("mutationId 必须是 1 到 256 个字符的字符串。");
  }
  if (typeof requestHash !== "string" || !requestHash.trim() || requestHash.length > 512) {
    throw new TypeError("requestHash 必须是 1 到 512 个字符的字符串。");
  }
  return { mutationId: mutationId.trim(), requestHash: requestHash.trim() };
}

function uuidFromMutationId(mutationId) {
  const bytes = createHash("sha256")
    .update("shendumao-context-map:create\0", "utf8")
    .update(mutationId, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizePageOptions({ limit, offset = 0 } = {}, defaultLimit) {
  const selectedLimit = limit === undefined ? defaultLimit : limit;
  if (!Number.isSafeInteger(selectedLimit) || selectedLimit < 0) {
    throw new TypeError("limit 必须是非负整数。");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("offset 必须是非负整数。");
  }
  return { limit: selectedLimit, offset };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function pathStat(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function syncDirectory(path) {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows does not consistently permit opening directories. The file is
    // still fsynced before its atomic rename, which is the essential guarantee.
  }
}

function lockIdentity(owner, details) {
  return {
    token: typeof owner?.token === "string" ? owner.token : null,
    dev: details?.dev,
    ino: details?.ino,
    birthtimeMs: details?.birthtimeMs,
  };
}

function sameLockIdentity(left, right) {
  if (left.token || right.token) return Boolean(left.token && left.token === right.token);
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

export class MapRepository {
  constructor({
    root = resolveDataRoot(),
    now = () => new Date(),
    clock = () => Date.now(),
    uuid = randomUUID,
    lockStaleMs = DEFAULT_LOCK_STALE_MS,
    lockRetryMs = DEFAULT_LOCK_RETRY_MS,
    lockRetries = DEFAULT_LOCK_RETRIES,
  } = {}) {
    this.root = resolve(root);
    this.mapsRoot = join(this.root, "maps");
    this.now = now;
    this.clock = clock;
    this.uuid = uuid;
    this.lockStaleMs = lockStaleMs;
    this.lockRetryMs = lockRetryMs;
    this.lockRetries = lockRetries;
  }

  async initialize() {
    await mkdir(this.mapsRoot, { recursive: true, mode: 0o700 });
  }

  mapDirectory(mapId) {
    return join(this.mapsRoot, assertMapId(mapId));
  }

  _timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("now() 必须返回有效日期。");
    return date.toISOString();
  }

  async _revisionNumbers(mapId, { allowEmpty = false } = {}) {
    const normalizedId = assertMapId(mapId);
    const directory = this.mapDirectory(normalizedId);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (allowEmpty) return [];
        throw new MapNotFoundError(normalizedId);
      }
      throw error;
    }
    const revisions = entries
      .filter((entry) => entry.isFile())
      .map((entry) => REVISION_FILE_PATTERN.exec(entry.name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .filter((revision) => Number.isSafeInteger(revision) && revision > 0)
      .sort((left, right) => left - right);
    if (!revisions.length && !allowEmpty) throw new MapNotFoundError(normalizedId);
    return revisions;
  }

  async _readRecord(mapId, revision) {
    const normalizedId = assertMapId(mapId);
    const normalizedRevision = assertRevision(revision);
    const path = join(this.mapDirectory(normalizedId), revisionFileName(normalizedRevision));
    let record;
    try {
      record = await readJson(path);
    } catch (error) {
      if (error?.code === "ENOENT") throw new MapNotFoundError(normalizedId, normalizedRevision);
      throw error;
    }
    if (
      record?.format !== RECORD_FORMAT
      || record?.schemaVersion !== RECORD_SCHEMA_VERSION
      || record?.mapId !== normalizedId
      || record?.revision !== normalizedRevision
    ) {
      throw new Error(`地图 ${normalizedId} 的版本 ${normalizedRevision} 文件格式无效。`);
    }
    return record;
  }

  async get(mapId, revision = undefined) {
    const normalizedId = assertMapId(mapId);
    const revisions = await this._revisionNumbers(normalizedId);
    const selected = revision === undefined ? revisions.at(-1) : assertRevision(revision);
    if (!revisions.includes(selected)) throw new MapNotFoundError(normalizedId, selected);
    return this._readRecord(normalizedId, selected);
  }

  async list(options = {}) {
    const { limit, offset } = normalizePageOptions(options, 20);
    if (limit === 0) return [];
    await this.initialize();
    const entries = await readdir(this.mapsRoot, { withFileTypes: true });
    const latestRecords = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && MAP_ID_PATTERN.test(entry.name))
      .map(async (entry) => {
        try {
          return await this.get(entry.name);
        } catch (error) {
          if (error instanceof MapNotFoundError) return null;
          throw error;
        }
      }));
    return latestRecords
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.mapId.localeCompare(right.mapId))
      .slice(offset, offset + limit);
  }

  async listRevisions(mapId, options = {}) {
    const normalizedId = assertMapId(mapId);
    const { limit, offset } = normalizePageOptions(options, 100);
    const order = options.order ?? "asc";
    if (order !== "asc" && order !== "desc") throw new TypeError("order 必须是 asc 或 desc。");
    const revisions = await this._revisionNumbers(normalizedId);
    if (order === "desc") revisions.reverse();
    const selected = revisions.slice(offset, offset + limit);
    return Promise.all(selected.map((revision) => this._readRecord(normalizedId, revision)));
  }

  async _findMutation(mapId, revisions, mutation) {
    if (!mutation.mutationId) return null;
    for (const revision of revisions) {
      const record = await this._readRecord(mapId, revision);
      if (record.mutationId !== mutation.mutationId) continue;
      if (record.requestHash === mutation.requestHash) return record;
      throw new IdempotencyKeyReuseError({
        mapId,
        mutationId: mutation.mutationId,
        existingRequestHash: record.requestHash,
        receivedRequestHash: mutation.requestHash,
        revision: record.revision,
      });
    }
    return null;
  }

  /**
   * Find an idempotent write across the complete immutable history. This is
   * deliberately independent of listRevisions pagination: correctness must not
   * change once a map grows beyond the UI/history listing limit.
   */
  async findMutation(mapId, mutationId, requestHash) {
    const normalizedId = assertMapId(mapId);
    const mutation = normalizeMutationOptions({ mutationId, requestHash });
    if (!mutation.mutationId) {
      throw new TypeError("findMutation 必须提供 mutationId 与 requestHash。");
    }
    const revisions = await this._revisionNumbers(normalizedId);
    // Recent keys are more common, but the scan never truncates old history.
    revisions.reverse();
    return this._findMutation(normalizedId, revisions, mutation);
  }

  async _writeRevision(record) {
    const directory = this.mapDirectory(record.mapId);
    const target = join(directory, revisionFileName(record.revision));
    if (await pathStat(target)) {
      throw new RevisionConflictError(record.mapId, record.revision - 1, record.revision);
    }
    const temporary = join(
      directory,
      `.${revisionFileName(record.revision)}.${process.pid}-${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (await pathStat(target)) {
        throw new RevisionConflictError(record.mapId, record.revision - 1, record.revision);
      }
      await rename(temporary, target);
      await syncDirectory(directory);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async _readLockOwner(lockPath) {
    try {
      return await readJson(join(lockPath, "owner.json"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async _recoverStaleLock(lockPath, contenderToken) {
    const firstStat = await pathStat(lockPath);
    if (!firstStat) return true;
    const firstOwner = await this._readLockOwner(lockPath);
    const firstOwnerStat = await pathStat(join(lockPath, "owner.json"));
    const firstIdentity = lockIdentity(firstOwner, firstStat);
    const ownerHeartbeat = Date.parse(firstOwner?.heartbeatAt || firstOwner?.acquiredAt || "");
    const lastTouch = Math.max(
      firstStat.mtimeMs,
      firstOwnerStat?.mtimeMs ?? 0,
      Number.isFinite(ownerHeartbeat) ? ownerHeartbeat : 0,
    );
    if (this.clock() - lastTouch <= this.lockStaleMs) return false;

    const secondStat = await pathStat(lockPath);
    if (!secondStat) return true;
    const secondOwner = await this._readLockOwner(lockPath);
    const secondIdentity = lockIdentity(secondOwner, secondStat);
    if (!sameLockIdentity(firstIdentity, secondIdentity)) return false;

    const quarantine = `${lockPath}.stale-${contenderToken}`;
    try {
      await rename(lockPath, quarantine);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EEXIST" || error?.code === "EPERM") return false;
      throw error;
    }

    const movedStat = await pathStat(quarantine);
    const movedOwner = movedStat ? await this._readLockOwner(quarantine) : null;
    if (!movedStat || !sameLockIdentity(secondIdentity, lockIdentity(movedOwner, movedStat))) {
      if (movedStat && !(await pathStat(lockPath))) await rename(quarantine, lockPath).catch(() => {});
      return false;
    }
    await rm(quarantine, { recursive: true, force: true });
    await syncDirectory(join(lockPath, ".."));
    return true;
  }

  async _acquireLock(mapId) {
    const directory = this.mapDirectory(mapId);
    const lockPath = join(directory, ".write.lock");
    const token = `${process.pid}-${randomUUID()}`;

    for (let attempt = 0; attempt <= this.lockRetries; attempt += 1) {
      let createdLock = false;
      try {
        await mkdir(lockPath, { mode: 0o700 });
        createdLock = true;
        const instant = new Date(this.clock()).toISOString();
        const owner = { token, pid: process.pid, acquiredAt: instant, heartbeatAt: instant };
        const ownerHandle = await open(join(lockPath, "owner.json"), "wx", 0o600);
        try {
          await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await ownerHandle.sync();
        } finally {
          await ownerHandle.close();
        }
        await syncDirectory(lockPath);
        const heartbeatMs = Math.max(10, Math.floor(this.lockStaleMs / 3));
        const heartbeat = setInterval(() => {
          const time = new Date(this.clock());
          utimes(lockPath, time, time).catch(() => {});
          utimes(join(lockPath, "owner.json"), time, time).catch(() => {});
        }, heartbeatMs);
        heartbeat.unref?.();
        return { lockPath, token, heartbeat };
      } catch (error) {
        if (createdLock) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }

      if (await this._recoverStaleLock(lockPath, token)) continue;
      if (attempt < this.lockRetries) await delay(this.lockRetryMs);
    }

    const error = new Error(`等待地图 ${mapId} 的写入锁超时。`);
    error.code = "SHENDUMAO_LOCK_TIMEOUT";
    throw error;
  }

  async _releaseLock(lock) {
    clearInterval(lock.heartbeat);
    const owner = await this._readLockOwner(lock.lockPath);
    if (owner?.token !== lock.token) return;
    const releasedPath = `${lock.lockPath}.released-${lock.token}`;
    try {
      await rename(lock.lockPath, releasedPath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const movedOwner = await this._readLockOwner(releasedPath);
    if (movedOwner?.token !== lock.token) {
      if (!(await pathStat(lock.lockPath))) await rename(releasedPath, lock.lockPath).catch(() => {});
      return;
    }
    await rm(releasedPath, { recursive: true, force: true });
    await syncDirectory(join(lock.lockPath, ".."));
  }

  async _withMapLock(mapId, operation) {
    const lock = await this._acquireLock(mapId);
    try {
      return await operation();
    } finally {
      await this._releaseLock(lock);
    }
  }

  async create(map, options = {}) {
    const normalizedMap = normalizeMap(map);
    const mutation = normalizeMutationOptions(options);
    const change = normalizeChange(options.change);
    const sourceCheckpoint = normalizeSourceCheckpoint(options.sourceCheckpoint);
    await this.initialize();

    let mapId;
    if (mutation.mutationId) {
      mapId = `map-${uuidFromMutationId(mutation.mutationId)}`;
      await mkdir(this.mapDirectory(mapId), { recursive: true, mode: 0o700 });
    } else {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = `map-${this.uuid()}`.toLowerCase();
        assertMapId(candidate);
        try {
          await mkdir(this.mapDirectory(candidate), { mode: 0o700 });
          mapId = candidate;
          break;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
      }
      if (!mapId) throw new Error("无法分配唯一的地图 ID。");
    }

    return this._withMapLock(mapId, async () => {
      const revisions = await this._revisionNumbers(mapId, { allowEmpty: true });
      const idempotent = await this._findMutation(mapId, revisions, mutation);
      if (idempotent) return idempotent;
      if (revisions.length) throw new RevisionConflictError(mapId, 0, revisions.at(-1));

      const timestamp = this._timestamp();
      const record = {
        format: RECORD_FORMAT,
        schemaVersion: RECORD_SCHEMA_VERSION,
        mapId,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        mutationId: mutation.mutationId,
        requestHash: mutation.requestHash,
        change,
        sourceCheckpoint,
        map: normalizedMap,
      };
      await this._writeRevision(record);
      return record;
    });
  }

  async update(mapId, map, options = {}) {
    const normalizedId = assertMapId(mapId);
    const normalizedMap = normalizeMap(map);
    const mutation = normalizeMutationOptions(options);
    const expectedRevision = assertRevision(options.expectedRevision, "expectedRevision");
    const change = normalizeChange(options.change);
    const hasSourceCheckpoint = Object.prototype.hasOwnProperty.call(options, "sourceCheckpoint");
    const suppliedCheckpoint = hasSourceCheckpoint
      ? normalizeSourceCheckpoint(options.sourceCheckpoint)
      : undefined;

    const directory = this.mapDirectory(normalizedId);
    if (!(await pathStat(directory))) throw new MapNotFoundError(normalizedId);

    return this._withMapLock(normalizedId, async () => {
      const revisions = await this._revisionNumbers(normalizedId);
      const idempotent = await this._findMutation(normalizedId, revisions, mutation);
      if (idempotent) return idempotent;

      const actualRevision = revisions.at(-1);
      if (expectedRevision !== actualRevision) {
        throw new RevisionConflictError(normalizedId, expectedRevision, actualRevision);
      }
      const previous = await this._readRecord(normalizedId, actualRevision);
      const record = {
        format: RECORD_FORMAT,
        schemaVersion: RECORD_SCHEMA_VERSION,
        mapId: normalizedId,
        revision: actualRevision + 1,
        createdAt: previous.createdAt,
        updatedAt: this._timestamp(),
        mutationId: mutation.mutationId,
        requestHash: mutation.requestHash,
        change,
        sourceCheckpoint: hasSourceCheckpoint ? suppliedCheckpoint : (previous.sourceCheckpoint ?? null),
        map: normalizedMap,
      };
      await this._writeRevision(record);
      return record;
    });
  }
}
