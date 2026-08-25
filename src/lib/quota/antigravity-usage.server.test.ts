import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { scanAntigravityUsage } from "./antigravity-usage.server.ts";

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function uint(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function bytes(field: number, value: Uint8Array): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(value.byteLength), Buffer.from(value)]);
}

function timestamp(ms: number): Buffer {
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1_000_000;
  return Buffer.concat([uint(1, seconds), uint(2, nanos)]);
}

function usage(values: {
  model: number;
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
  thinking?: number;
  response?: number;
}): Buffer {
  const fields = [uint(1, values.model), uint(2, values.input), uint(3, values.output)];
  if (values.cacheWrite != null) fields.push(uint(4, values.cacheWrite));
  if (values.cacheRead != null) fields.push(uint(5, values.cacheRead));
  if (values.thinking != null) fields.push(uint(9, values.thinking));
  if (values.response != null) fields.push(uint(10, values.response));
  return Buffer.concat(fields);
}

function stepMetadata(ms: number, modelUsage: Uint8Array): Buffer {
  return Buffer.concat([bytes(1, timestamp(ms)), bytes(9, modelUsage)]);
}

function executorMetadata(model: number, modelId: string): Buffer {
  const config = Buffer.concat([uint(1, model), bytes(28, Buffer.from(modelId))]);
  return bytes(10, bytes(1, config));
}

function createFixture(directory: string, fileName: string): string {
  const path = join(directory, fileName);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB)");
  db.exec("CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY, data BLOB)");
  db.prepare("INSERT INTO executor_metadata(idx, data) VALUES (?, ?)")
    .run(0, executorMetadata(1298, "gemini-3.7-flash-high"));
  db.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)").run(
    2,
    stepMetadata(Date.parse("2026-08-25T03:30:00Z"), usage({
      model: 1298,
      input: 13880,
      output: 190,
      cacheRead: 12194,
      thinking: 175,
      response: 15,
    })),
  );
  db.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)").run(
    3,
    Buffer.from([0x4a, 0x05, 0x08]),
  );
  db.close();
  return path;
}

test("scanAntigravityUsage decodes timestamp, model and token fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "balance-antigravity-usage-"));
  try {
    createFixture(directory, "conversation.db");
    const result = scanAntigravityUsage(Date.parse("2026-08-25T03:00:00Z"), {
      conversationsDir: directory,
      now: Date.parse("2026-08-25T04:00:00Z"),
    });
    assert.equal(result.databasesRead, 1);
    assert.equal(result.filesSkipped, 0);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.events.map((event) => ({
      ts: event.ts,
      model: event.model,
      quotaGroup: event.quotaGroup,
      tokensIn: event.tokensIn,
      tokensOut: event.tokensOut,
      cacheRead: event.cacheRead,
      cacheWrite: event.cacheWrite,
      thinkingTokens: event.thinkingTokens,
      responseTokens: event.responseTokens,
    })), [{
      ts: Date.parse("2026-08-25T03:30:00Z"),
      model: "gemini-3.7-flash-high",
      quotaGroup: "gemini",
      tokensIn: 13880,
      tokensOut: 190,
      cacheRead: 12194,
      cacheWrite: 0,
      thinkingTokens: 175,
      responseTokens: 15,
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanAntigravityUsage keeps unknown enums unpriced and skips broken databases", () => {
  const directory = mkdtempSync(join(tmpdir(), "balance-antigravity-usage-"));
  try {
    const path = join(directory, "unknown.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB)");
    db.exec("CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY, data BLOB)");
    db.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)").run(
      1,
      stepMetadata(Date.parse("2026-08-25T03:45:00Z"), usage({
        model: 777,
        input: 100,
        output: 20,
      })),
    );
    db.close();
    writeFileSync(join(directory, "broken.db"), Buffer.from("not sqlite"));
    const result = scanAntigravityUsage(0, {
      conversationsDir: directory,
      now: Date.parse("2026-08-25T05:00:00Z"),
    });
    assert.equal(result.databasesRead, 1);
    assert.equal(result.filesSkipped, 1);
    assert.equal(result.events[0]?.model, "unknown-777");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanAntigravityUsage rejects symlinks and never exposes event identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "balance-antigravity-usage-"));
  const directory = join(root, "conversations");
  const outside = join(root, "outside");
  try {
    mkdirSync(directory);
    mkdirSync(outside);
    const outsideDb = createFixture(outside, "outside.db");
    symlinkSync(outsideDb, join(directory, "linked.db"));
    const result = scanAntigravityUsage(0, {
      conversationsDir: directory,
      now: Date.parse("2026-08-25T05:00:00Z"),
    });
    assert.equal(result.databasesRead, 0);
    assert.equal(result.filesSkipped, 1);
    assert.equal(result.events.length, 0);
    assert.equal(JSON.stringify(result).includes("outside"), false);
    assert.equal(JSON.stringify(result).includes('"id"'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanAntigravityUsage bounds rows, fails closed on malformed protobuf, and filters far-future timestamps", () => {
  const directory = mkdtempSync(join(tmpdir(), "balance-antigravity-usage-"));
  try {
    const path = createFixture(directory, "bounded.db");
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)").run(10, Buffer.alloc(2 * 1024 * 1024 + 1));
    db.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)").run(11, Buffer.from([0x0f]));
    db.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)").run(12, Buffer.alloc(10, 0x80));
    db.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)").run(
      13,
      stepMetadata(Number.MAX_SAFE_INTEGER, usage({ model: 1298, input: 1, output: 1 })),
    );
    const tooManyFields = Buffer.alloc((4096 + 1) * 2);
    for (let offset = 0; offset < tooManyFields.length; offset += 2) {
      tooManyFields[offset] = 0x08;
    }
    db.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)").run(14, tooManyFields);
    db.close();
    const result = scanAntigravityUsage(0, {
      conversationsDir: directory,
      now: Date.parse("2026-08-25T05:00:00Z"),
      maxStepRowsPerDatabase: 3,
      maxEvents: 2,
    });
    assert.equal(result.truncated, true);
    assert.equal(result.events.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanAntigravityUsage reads an active WAL in read-only mode", () => {
  const directory = mkdtempSync(join(tmpdir(), "balance-antigravity-usage-"));
  let writer: DatabaseSync | null = null;
  try {
    const path = join(directory, "active.db");
    writer = new DatabaseSync(path);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB)");
    writer.exec("CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY, data BLOB)");
    writer.prepare("INSERT INTO executor_metadata(idx, data) VALUES (?, ?)")
      .run(0, executorMetadata(1298, "gemini-3.7-flash-high"));
    writer.prepare("INSERT INTO steps(idx, metadata) VALUES (?, ?)").run(
      1,
      stepMetadata(Date.parse("2026-08-25T03:30:00Z"), usage({ model: 1298, input: 8, output: 3 })),
    );
    const result = scanAntigravityUsage(0, {
      conversationsDir: directory,
      now: Date.parse("2026-08-25T05:00:00Z"),
    });
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.tokensIn, 8);
  } finally {
    writer?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scanAntigravityUsage enforces a total database byte budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "balance-antigravity-usage-"));
  try {
    createFixture(directory, "budgeted.db");
    const result = scanAntigravityUsage(0, {
      conversationsDir: directory,
      now: Date.parse("2026-08-25T05:00:00Z"),
      maxTotalDatabaseBytes: 1,
    });
    assert.equal(result.databasesRead, 0);
    assert.equal(result.truncated, true);
    assert.equal(result.events.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
