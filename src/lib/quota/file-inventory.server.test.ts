import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, truncateSync, unlinkSync, symlinkSync, mkdirSync, rmSync, renameSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Create a real-path-resolved temp directory (macOS /var -> /private/var) */
import {
  createFileInventory,
  refreshFileInventory,
  snapshotInventoryEntries,
  readChunkFromEntry,
  EMPTY_FILE_CURSOR,
  type InventoryEntry,
  type FileInventory,
  type FileCursor,
} from "./file-inventory.server.ts";

function countingLstat(counter: { count: number }) {
  const fn = (...args: Parameters<typeof lstatSync>) => { counter.count++; return lstatSync(...args); };
  return fn as unknown as typeof lstatSync;
}
function countingRealpath(counter: { count: number }) {
  const fn = (...args: Parameters<typeof realpathSync>) => { counter.count++; return realpathSync(...args); };
  (fn as any).native = realpathSync.native;
  return fn as unknown as typeof realpathSync;
}
function countingStat(counter: { count: number }) {
  const fn = (...args: Parameters<typeof statSync>) => { counter.count++; return statSync(...args); };
  return fn as unknown as typeof statSync;
}

function makeTmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "fi-test-")));
}

describe("file-inventory.server parser scanner tests", () => {
  describe("refreshFileInventory", () => {
    it("discovers files on first call at 0s", () => {
      const root = makeTmpDir();
      writeFileSync(join(root, "session.jsonl"), "line1\n");
      writeFileSync(join(root, "other.txt"), "nope\n");
      const inventory = createFileInventory();
      const result = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      assert.equal(result.refreshed, true);
      assert.equal(result.entries.length, 1);
      assert.equal(result.entries[0]!.path, join(root, "session.jsonl"));
      rmSync(root, { recursive: true, force: true });
    });

    it("does not refresh before intervalMs elapses", () => {
      const root = makeTmpDir();
      writeFileSync(join(root, "a.jsonl"), "x\n");
      const inventory = createFileInventory();
      refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      // Add a new file
      writeFileSync(join(root, "b.jsonl"), "y\n");
      const result = refreshFileInventory({
        roots: [root],
        now: 10_000, // only 9s later - less than 15s interval
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      // Should not have refreshed - new file not discovered yet
      assert.equal(result.refreshed, false);
      assert.equal(result.entries.length, 1);
      rmSync(root, { recursive: true, force: true });
    });

    it("discovers new files after 16s", () => {
      const root = makeTmpDir();
      writeFileSync(join(root, "a.jsonl"), "x\n");
      const inventory = createFileInventory();
      refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      writeFileSync(join(root, "b.jsonl"), "y\n");
      const result = refreshFileInventory({
        roots: [root],
        now: 17_000, // 16s later
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      assert.equal(result.refreshed, true);
      assert.equal(result.entries.length, 2);
      rmSync(root, { recursive: true, force: true });
    });

    it("skips dotfiles and .lock files", () => {
      const root = makeTmpDir();
      writeFileSync(join(root, ".hidden.jsonl"), "x\n");
      writeFileSync(join(root, "valid.jsonl"), "x\n");
      writeFileSync(join(root, "something.lock"), "x\n");
      const inventory = createFileInventory();
      const result = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      assert.equal(result.entries.length, 1);
      assert.equal(result.entries[0]!.path, join(root, "valid.jsonl"));
      rmSync(root, { recursive: true, force: true });
    });

    it("skips symlinks pointing outside root", () => {
      const root = makeTmpDir();
      const outside = makeTmpDir();
      writeFileSync(join(outside, "secret.jsonl"), "sensitive\n");
      symlinkSync(join(outside, "secret.jsonl"), join(root, "link.jsonl"));
      const inventory = createFileInventory();
      const result = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      assert.equal(result.entries.length, 0);
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    it("skips directory symlinks", () => {
      const root = makeTmpDir();
      const outside = makeTmpDir();
      writeFileSync(join(outside, "file.jsonl"), "data\n");
      symlinkSync(outside, join(root, "linked-dir"));
      const inventory = createFileInventory();
      const result = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      assert.equal(result.entries.length, 0);
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    it("counts lstat/realpath/stat calls per file", () => {
      const root = makeTmpDir();
      writeFileSync(join(root, "a.jsonl"), "data1\n");
      writeFileSync(join(root, "b.jsonl"), "data2\n");
      const inventory = createFileInventory();
      const lc = { count: 0 };
      const rc = { count: 0 };
      const sc = { count: 0 };
      const result = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
        lstat: countingLstat(lc),
        realpath: countingRealpath(rc),
        stat: countingStat(sc),
      });
      assert.equal(result.entries.length, 2);
      // Each file: 1 lstat + 1 realpath + 1 stat; root: 1 lstat + 1 realpath
      assert.equal(lc.count, 3); // root + 2 files
      assert.equal(rc.count, 3); // root + 2 files
      assert.equal(sc.count, 2); // 2 files (root stat is lstat)
      rmSync(root, { recursive: true, force: true });
    });

    it("handles root deletion gracefully", () => {
      const root = makeTmpDir();
      writeFileSync(join(root, "a.jsonl"), "x\n");
      const inventory = createFileInventory();
      refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      rmSync(root, { recursive: true, force: true });
      const result = refreshFileInventory({
        roots: [root],
        now: 17_000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      assert.equal(result.refreshed, true);
      assert.equal(result.entries.length, 0);
    });

    it("recurses into subdirectories", () => {
      const root = makeTmpDir();
      mkdirSync(join(root, "sub"));
      writeFileSync(join(root, "sub", "deep.jsonl"), "nested\n");
      const inventory = createFileInventory();
      const result = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      assert.equal(result.entries.length, 1);
      assert.ok(result.entries[0]!.path.includes("deep.jsonl"));
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("snapshotInventoryEntries", () => {
    it("returns updated stats for known files on append", () => {
      const root = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      writeFileSync(filePath, "line1\n");
      const inventory = createFileInventory();
      const first = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      const originalSize = first.entries[0]!.size;
      appendFileSync(filePath, "line2\n");
      const snapshots = snapshotInventoryEntries(first.entries);
      assert.equal(snapshots.length, 1);
      assert.ok(snapshots[0]!.size > originalSize);
      rmSync(root, { recursive: true, force: true });
    });

    it("detects truncation", () => {
      const root = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      writeFileSync(filePath, "long content here\n");
      const inventory = createFileInventory();
      const first = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      truncateSync(filePath, 3);
      const snapshots = snapshotInventoryEntries(first.entries);
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]!.size, 3);
      rmSync(root, { recursive: true, force: true });
    });

    it("detects inode replacement", () => {
      const root = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      writeFileSync(filePath, "original\n");
      const inventory = createFileInventory();
      const first = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      // Atomic replace: write new file, rename over
      const tmpPath = join(root, "log.jsonl.tmp");
      writeFileSync(tmpPath, "replaced content\n");
      renameSync(tmpPath, filePath);
      const snapshots = snapshotInventoryEntries(first.entries);
      assert.equal(snapshots.length, 1);
      // Should have new content size
      assert.equal(snapshots[0]!.size, "replaced content\n".length);
      rmSync(root, { recursive: true, force: true });
    });

    it("excludes files that became symlinks", () => {
      const root = makeTmpDir();
      const outside = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      writeFileSync(filePath, "data\n");
      const inventory = createFileInventory();
      const first = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      // Replace real file with symlink to outside
      unlinkSync(filePath);
      writeFileSync(join(outside, "target.jsonl"), "external\n");
      symlinkSync(join(outside, "target.jsonl"), filePath);
      const snapshots = snapshotInventoryEntries(first.entries);
      assert.equal(snapshots.length, 0);
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    it("counts stat calls: one per entry", () => {
      const root = makeTmpDir();
      writeFileSync(join(root, "a.jsonl"), "a\n");
      writeFileSync(join(root, "b.jsonl"), "b\n");
      const inventory = createFileInventory();
      const first = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      const lc = { count: 0 };
      const rc = { count: 0 };
      const sc = { count: 0 };
      snapshotInventoryEntries(
        first.entries,
        countingLstat(lc),
        countingRealpath(rc),
        countingStat(sc),
      );
      // Each file: 1 lstat + 1 realpath + 1 stat
      assert.equal(lc.count, 2);
      assert.equal(rc.count, 2);
      assert.equal(sc.count, 2);
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe("readChunkFromEntry", () => {
    it("returns full content on first read with EMPTY_FILE_CURSOR", () => {
      const root = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      writeFileSync(filePath, "hello world\n");
      const inventory = createFileInventory();
      const snap = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      const entry = snap.entries[0]!;
      const { text, next } = readChunkFromEntry(entry, { ...EMPTY_FILE_CURSOR });
      assert.equal(text, "hello world\n");
      assert.equal(next.size, entry.size);
      assert.equal(next.dev, entry.dev);
      assert.equal(next.ino, entry.ino);
      rmSync(root, { recursive: true, force: true });
    });

    it("returns empty text when entry is unchanged", () => {
      const root = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      writeFileSync(filePath, "content\n");
      const inventory = createFileInventory();
      const snap = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      const entry = snap.entries[0]!;
      const { next } = readChunkFromEntry(entry, { ...EMPTY_FILE_CURSOR });
      // Read again with same entry (unchanged)
      const result = readChunkFromEntry(entry, next);
      assert.equal(result.text, "");
      rmSync(root, { recursive: true, force: true });
    });

    it("reads only appended content when file grows", () => {
      const root = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      writeFileSync(filePath, "line1\n");
      const inventory = createFileInventory();
      const snap = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      const entry = snap.entries[0]!;
      const { next: cursor1 } = readChunkFromEntry(entry, { ...EMPTY_FILE_CURSOR });

      // Append to file
      appendFileSync(filePath, "line2\n");
      const updatedEntries = snapshotInventoryEntries(snap.entries);
      const entry2 = updatedEntries[0]!;
      const { text, next: cursor2 } = readChunkFromEntry(entry2, cursor1);
      assert.equal(text, "line2\n");
      assert.equal(cursor2.size, entry2.size);
      rmSync(root, { recursive: true, force: true });
    });

    it("reads full content after truncation (new dev/ino)", () => {
      const root = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      writeFileSync(filePath, "original\n");
      const inventory = createFileInventory();
      const snap = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      const entry = snap.entries[0]!;
      const { next: cursor1 } = readChunkFromEntry(entry, { ...EMPTY_FILE_CURSOR });

      // Atomic replace (new inode)
      const tmpPath = join(root, "log.jsonl.new");
      writeFileSync(tmpPath, "new\n");
      renameSync(tmpPath, filePath);

      const updatedEntries = snapshotInventoryEntries(snap.entries);
      const entry2 = updatedEntries[0]!;
      const { text } = readChunkFromEntry(entry2, cursor1);
      // Since dev/ino changed, should read from start
      assert.equal(text, "new\n");
      rmSync(root, { recursive: true, force: true });
    });

    it("returns 0 bytes if file was replaced between inventory and open", () => {
      const root = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      writeFileSync(filePath, "original\n");
      const inventory = createFileInventory();
      const snap = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      const entry = snap.entries[0]!;
      // Replace the file between snapshot and read (race condition)
      const tmpPath = join(root, "log.jsonl.tmp");
      writeFileSync(tmpPath, "replaced\n");
      renameSync(tmpPath, filePath);
      // Entry still has old dev/ino but file on disk is different
      const { text } = readChunkFromEntry(entry, { ...EMPTY_FILE_CURSOR });
      // Should detect dev/ino mismatch and return empty
      assert.equal(text, "");
      rmSync(root, { recursive: true, force: true });
    });

    it("prepends cursor tail on append reads", () => {
      const root = makeTmpDir();
      const filePath = join(root, "log.jsonl");
      // Write initial content: one complete line + a partial line
      writeFileSync(filePath, "line1\npartial");
      const inventory = createFileInventory();
      const snap = refreshFileInventory({
        roots: [root],
        now: 1000,
        intervalMs: 15_000,
        inventory,
        accepts: (name) => name.endsWith(".jsonl"),
      });
      const entry = snap.entries[0]!;
      const { text, next } = readChunkFromEntry(entry, { ...EMPTY_FILE_CURSOR });
      assert.equal(text, "line1\npartial");
      // In real scanner usage: split on \n, pop() gives "partial" as tail
      // next.size = 13 (full file). Scanner saves {...next, tail: "partial"}
      const cursorWithTail: FileCursor = { ...next, tail: "partial" };
      // Now append more to the file
      appendFileSync(filePath, " rest\nline2\n");
      const updated = snapshotInventoryEntries(snap.entries);
      const entry2 = updated[0]!;
      // readChunkFromEntry will read bytes from cursorWithTail.size (13) to new end
      // which is " rest\nline2\n", then prepend the tail "partial"
      const { text: text2 } = readChunkFromEntry(entry2, cursorWithTail);
      assert.equal(text2, "partial rest\nline2\n");
      rmSync(root, { recursive: true, force: true });
    });
  });
});
