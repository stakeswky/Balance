import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  antigravityQuotaGroup,
  type AntigravityUsageEvent,
  type AntigravityUsageScanResult,
} from "./antigravity-usage.ts";

const MAX_DATABASE_FILES = 512;
const MAX_DATABASE_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_DATABASE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_WIRE_FIELDS = 4096;
const MAX_EXECUTOR_ROWS_PER_DATABASE = 4096;
const MAX_STEP_ROWS_PER_DATABASE = 100_000;
const MAX_EVENTS = 100_000;
const MODEL_ID = /^[a-z0-9][a-z0-9._@/-]{0,127}$/i;

interface WireField {
  number: number;
  wireType: number;
  varint?: number;
  bytes?: Uint8Array;
}

interface StepRow {
  idx: number | bigint;
  metadata: Uint8Array | null;
}

interface ExecutorRow {
  data: Uint8Array | null;
}

export interface ScanAntigravityUsageOptions {
  home?: string;
  conversationsDir?: string;
  now?: number;
  maxStepRowsPerDatabase?: number;
  maxEvents?: number;
  maxTotalDatabaseBytes?: number;
}

function readVarint(input: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0;
  let multiplier = 1;
  let cursor = offset;
  for (let index = 0; index < 10 && cursor < input.byteLength; index += 1) {
    const byte = input[cursor];
    if (byte == null) return null;
    cursor += 1;
    value += (byte & 0x7f) * multiplier;
    if (!Number.isSafeInteger(value)) return null;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    multiplier *= 128;
  }
  return null;
}

function decodeFields(input: Uint8Array): WireField[] | null {
  if (input.byteLength > MAX_BLOB_BYTES) return null;
  const fields: WireField[] = [];
  let cursor = 0;
  while (cursor < input.byteLength) {
    if (fields.length >= MAX_WIRE_FIELDS) return null;
    const key = readVarint(input, cursor);
    if (!key || key.value === 0) return null;
    cursor = key.next;
    const number = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (number === 0) return null;
    if (wireType === 0) {
      const decoded = readVarint(input, cursor);
      if (!decoded) return null;
      fields.push({ number, wireType, varint: decoded.value });
      cursor = decoded.next;
      continue;
    }
    if (wireType === 1) {
      if (cursor + 8 > input.byteLength) return null;
      fields.push({ number, wireType });
      cursor += 8;
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(input, cursor);
      if (!length) return null;
      cursor = length.next;
      if (length.value > MAX_BLOB_BYTES || cursor + length.value > input.byteLength) return null;
      fields.push({ number, wireType, bytes: input.subarray(cursor, cursor + length.value) });
      cursor += length.value;
      continue;
    }
    if (wireType === 5) {
      if (cursor + 4 > input.byteLength) return null;
      fields.push({ number, wireType });
      cursor += 4;
      continue;
    }
    return null;
  }
  return fields;
}

function firstVarint(fields: WireField[], number: number): number | null {
  const value = fields.find((field) => field.number === number && field.wireType === 0)?.varint;
  return value != null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function byteFields(fields: WireField[], number: number): Uint8Array[] {
  return fields.flatMap((field) =>
    field.number === number && field.wireType === 2 && field.bytes ? [field.bytes] : []
  );
}

function decodeTimestamp(fields: WireField[]): number | null {
  const encoded = byteFields(fields, 1)[0];
  if (!encoded) return null;
  const timestampFields = decodeFields(encoded);
  if (!timestampFields) return null;
  const seconds = firstVarint(timestampFields, 1);
  const nanos = firstVarint(timestampFields, 2) ?? 0;
  if (seconds == null || nanos >= 1_000_000_000) return null;
  const value = seconds * 1000 + Math.floor(nanos / 1_000_000);
  return Number.isSafeInteger(value) ? value : null;
}

function decodeModelMappings(rows: ExecutorRow[]): Map<number, string> {
  const mappings = new Map<number, string>();
  for (const row of rows) {
    if (!row.data || row.data.byteLength > MAX_BLOB_BYTES) continue;
    const outer = decodeFields(row.data);
    if (!outer) continue;
    for (const managerBytes of byteFields(outer, 10)) {
      const manager = decodeFields(managerBytes);
      if (!manager) continue;
      for (const configBytes of byteFields(manager, 1)) {
        const config = decodeFields(configBytes);
        if (!config) continue;
        const modelEnum = firstVarint(config, 1);
        const modelBytes = byteFields(config, 28)[0];
        if (modelEnum == null || !modelBytes) continue;
        const model = Buffer.from(modelBytes).toString("utf8");
        if (MODEL_ID.test(model)) mappings.set(modelEnum, model);
      }
    }
  }
  return mappings;
}

function decodeStep(
  metadata: Uint8Array,
  models: Map<number, string>,
): AntigravityUsageEvent | null {
  const fields = decodeFields(metadata);
  if (!fields) return null;
  const ts = decodeTimestamp(fields);
  const usageBytes = byteFields(fields, 9)[0];
  if (ts == null || !usageBytes) return null;
  const usage = decodeFields(usageBytes);
  if (!usage) return null;
  const modelEnum = firstVarint(usage, 1);
  if (modelEnum == null) return null;
  const thinkingTokens = firstVarint(usage, 9) ?? 0;
  const responseTokens = firstVarint(usage, 10) ?? 0;
  const reportedOutput = firstVarint(usage, 3);
  const event: AntigravityUsageEvent = {
    ts,
    model: models.get(modelEnum) ?? `unknown-${modelEnum}`,
    quotaGroup: "claude-gpt",
    tokensIn: firstVarint(usage, 2) ?? 0,
    tokensOut: reportedOutput ?? thinkingTokens + responseTokens,
    cacheRead: firstVarint(usage, 5) ?? 0,
    cacheWrite: firstVarint(usage, 4) ?? 0,
    thinkingTokens,
    responseTokens,
  };
  event.quotaGroup = antigravityQuotaGroup(event.model);
  const tokenValues = [
    event.tokensIn,
    event.tokensOut,
    event.cacheRead,
    event.cacheWrite,
    event.thinkingTokens,
    event.responseTokens,
  ];
  if (tokenValues.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
  const total = event.tokensIn + event.tokensOut + event.cacheRead + event.cacheWrite;
  return Number.isSafeInteger(total) && total > 0 ? event : null;
}

function hasRequiredTables(db: DatabaseSync): boolean {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('steps', 'executor_metadata')",
  ).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name)).size === 2;
}

export function scanAntigravityUsage(
  since: number,
  options: ScanAntigravityUsageOptions = {},
): AntigravityUsageScanResult {
  const now = options.now ?? Date.now();
  const directory = options.conversationsDir
    ?? join(options.home ?? homedir(), ".gemini", "antigravity-cli", "conversations");
  const requestedStepRows = options.maxStepRowsPerDatabase;
  const requestedEvents = options.maxEvents;
  const requestedDatabaseBytes = options.maxTotalDatabaseBytes;
  const maxStepRows = Number.isSafeInteger(requestedStepRows) && (requestedStepRows ?? 0) > 0
    ? Math.min(MAX_STEP_ROWS_PER_DATABASE, requestedStepRows as number)
    : MAX_STEP_ROWS_PER_DATABASE;
  const maxEvents = Number.isSafeInteger(requestedEvents) && (requestedEvents ?? 0) > 0
    ? Math.min(MAX_EVENTS, requestedEvents as number)
    : MAX_EVENTS;
  const maxTotalDatabaseBytes = Number.isSafeInteger(requestedDatabaseBytes)
    && (requestedDatabaseBytes ?? 0) > 0
    ? Math.min(MAX_TOTAL_DATABASE_BYTES, requestedDatabaseBytes as number)
    : MAX_TOTAL_DATABASE_BYTES;
  const events: AntigravityUsageEvent[] = [];
  let databasesRead = 0;
  let filesSkipped = 0;
  let totalDatabaseBytes = 0;
  let truncated = false;
  let names: string[] = [];
  let canonicalDirectory = "";
  try {
    canonicalDirectory = realpathSync(directory);
    if (!statSync(canonicalDirectory).isDirectory()) throw new Error("not a directory");
    const candidates = readdirSync(canonicalDirectory)
      .filter((name) => name.endsWith(".db"))
      .sort();
    truncated = candidates.length > MAX_DATABASE_FILES;
    names = candidates.slice(0, MAX_DATABASE_FILES);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (events.length >= maxEvents) {
      truncated = true;
      break;
    }
    let db: DatabaseSync | null = null;
    try {
      const candidate = join(canonicalDirectory, name);
      const entryStats = lstatSync(candidate);
      if (entryStats.isSymbolicLink() || !entryStats.isFile()) {
        filesSkipped += 1;
        continue;
      }
      const path = realpathSync(candidate);
      if (dirname(path) !== canonicalDirectory) {
        filesSkipped += 1;
        continue;
      }
      const stats = statSync(path);
      if (!stats.isFile() || stats.size > MAX_DATABASE_BYTES) {
        filesSkipped += 1;
        continue;
      }
      if (totalDatabaseBytes + stats.size > maxTotalDatabaseBytes) {
        truncated = true;
        break;
      }
      totalDatabaseBytes += stats.size;
      db = new DatabaseSync(path, { readOnly: true });
      if (!hasRequiredTables(db)) {
        filesSkipped += 1;
        continue;
      }
      const executorRows = db.prepare(
        "SELECT data FROM executor_metadata WHERE data IS NOT NULL ORDER BY idx DESC LIMIT ?",
      ).all(MAX_EXECUTOR_ROWS_PER_DATABASE + 1) as unknown as ExecutorRow[];
      if (executorRows.length > MAX_EXECUTOR_ROWS_PER_DATABASE) truncated = true;
      const models = decodeModelMappings(
        executorRows.slice(0, MAX_EXECUTOR_ROWS_PER_DATABASE).reverse(),
      );
      const queriedRows = db.prepare(
        "SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx DESC LIMIT ?",
      ).all(maxStepRows + 1) as unknown as StepRow[];
      if (queriedRows.length > maxStepRows) truncated = true;
      const rows = queriedRows.slice(0, maxStepRows);
      databasesRead += 1;
      for (const row of rows) {
        if (events.length >= maxEvents) {
          truncated = true;
          break;
        }
        if (!row.metadata || row.metadata.byteLength > MAX_BLOB_BYTES) continue;
        const event = decodeStep(row.metadata, models);
        if (!event || event.ts < since || event.ts > now + 60_000) continue;
        events.push(event);
      }
    } catch {
      filesSkipped += 1;
    } finally {
      try {
        db?.close();
      } catch {
        db = null;
      }
    }
  }
  events.sort((left, right) => left.ts - right.ts || left.model.localeCompare(right.model));
  return {
    events,
    databasesRead,
    filesSkipped,
    truncated,
    fetchedAt: now,
    source: "antigravity-conversation-db",
  };
}
