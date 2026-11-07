import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const sourceUrl = new URL("../extensions/recording-source.ts", import.meta.url);

async function loadRecordingSource() {
  const source = await readFile(sourceUrl, "utf8");
  const compiled = stripTypeScriptTypes(source, { mode: "strip" });

  const tempDir = await mkdtemp(join(tmpdir(), "pi-superwhisper-recording-"));
  const modulePath = join(tempDir, "recording-source.mjs");
  await writeFile(modulePath, compiled, "utf8");

  return {
    module: await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`),
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

/** Creates a temp "recordings" folder and a helper to add recording folders. */
async function makeRecordingsDir() {
  const dir = await mkdtemp(join(tmpdir(), "sw-recordings-"));

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    async addRecording(id, meta, { raw } = {}) {
      const folder = join(dir, String(id));
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, "meta.json"),
        raw ?? JSON.stringify(meta),
        "utf8",
      );
      return folder;
    },
    async addEmptyRecording(id) {
      const folder = join(dir, String(id));
      await mkdir(folder, { recursive: true });
      return folder;
    },
  };
}

test("highWaterMark is 0 for a missing folder", async () => {
  const { module, cleanup } = await loadRecordingSource();
  try {
    assert.equal(module.highWaterMark(join(tmpdir(), "definitely-not-here-12345")), 0);
  } finally {
    await cleanup();
  }
});

test("highWaterMark ignores non-numeric folder names", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  try {
    await rec.addRecording("1793612887", { result: "a" });
    await rec.addRecording("tmp-not-a-timestamp", { result: "b" });
    assert.equal(module.highWaterMark(rec.dir), 1793612887);
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("readRecordingResult reports pending for a missing meta.json", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  try {
    await rec.addEmptyRecording("1793612900");
    assert.deepEqual(module.readRecordingResult(rec.dir, "1793612900", 8000), {
      pending: true,
    });
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("readRecordingResult reports pending for a half-written meta.json", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  try {
    await rec.addRecording("1793612901", undefined, { raw: '{"result": "unfinished' });
    assert.deepEqual(module.readRecordingResult(rec.dir, "1793612901", 8000), {
      pending: true,
    });
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("readRecordingResult reports pending when result is blank", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  try {
    await rec.addRecording("1793612902", { result: "   " });
    assert.deepEqual(module.readRecordingResult(rec.dir, "1793612902", 8000), {
      pending: true,
    });
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("readRecordingResult returns trimmed text", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  try {
    await rec.addRecording("1793612903", { result: "  おはようございます。  " });
    assert.deepEqual(module.readRecordingResult(rec.dir, "1793612903", 8000), {
      text: "おはようございます。",
    });
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("readRecordingResult truncates to maxChars", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  try {
    await rec.addRecording("1793612904", { result: "abcdefghij" });
    assert.deepEqual(module.readRecordingResult(rec.dir, "1793612904", 4), {
      text: "abcd",
    });
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("source delivers a recording newer than the high-water mark", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const delivered = [];

  try {
    await rec.addRecording("1793612887", { result: "history" });

    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: (text) => delivered.push(text),
    });

    source.start();
    assert.equal(source.isRunning(), true);

    await rec.addRecording("1793612900", { result: "新しい音声" });
    source.consider("1793612900");

    assert.deepEqual(delivered, ["新しい音声"]);
    source.stop();
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("source ignores recordings at or below the high-water mark", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const delivered = [];

  try {
    await rec.addRecording("1793612887", { result: "already here" });

    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: (text) => delivered.push(text),
    });
    source.start();

    // Re-reporting history must not resurrect it.
    source.consider("1793612887");
    assert.deepEqual(delivered, []);
    source.stop();
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("source delivers each recording exactly once", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const delivered = [];

  try {
    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: (text) => delivered.push(text),
    });
    source.start();

    await rec.addRecording("1793612901", { result: "一度だけ" });
    source.consider("1793612901");
    source.consider("1793612901");
    source.poll();
    source.consider("1793612901");

    assert.deepEqual(delivered, ["一度だけ"]);
    source.stop();
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("idle poll finds a recording that fs.watch did not report", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const delivered = [];

  try {
    await rec.addRecording("1793612887", { result: "history" });
    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: (text) => delivered.push(text),
    });
    source.start();

    await rec.addRecording("1793612950", { result: "watch missed this" });
    // No consider(): only the idle poll's listing can find it.
    source.poll();
    assert.deepEqual(delivered, ["watch missed this"]);

    // A late watch event or another poll must not deliver it again.
    source.consider("1793612950");
    source.poll();
    assert.deepEqual(delivered, ["watch missed this"]);
    source.stop();
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("a removed recording folder leaves pending and the idle listing resumes", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const delivered = [];
  const logs = [];

  try {
    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: (text) => delivered.push(text),
      log: (_level, message) => logs.push(message),
    });
    source.start();

    const folder = await rec.addEmptyRecording("1793612960");
    source.consider("1793612960");
    await rm(folder, { recursive: true, force: true });
    // The vanished folder is dropped, so the source returns to the idle cadence.
    source.poll();
    assert.ok(
      logs.some((message) => message.includes("give up on recording 1793612960 (folder gone)")),
      `expected the vanished folder to be dropped, got ${JSON.stringify(logs)}`,
    );

    await rec.addRecording("1793612970", { result: "after a cancelled recording" });
    source.poll();

    assert.deepEqual(delivered, ["after a cancelled recording"]);
    source.stop();
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("source waits for a late meta.json and then delivers once", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const delivered = [];

  try {
    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: (text) => delivered.push(text),
      freshMs: 60_000,
    });
    source.start();

    // Folder announced before its meta.json exists, as fs.watch does.
    await rec.addEmptyRecording("1793612902");
    source.consider("1793612902");
    assert.deepEqual(delivered, []);

    await rec.addRecording("1793612902", { result: "遅れて届いた" });
    source.poll();

    assert.deepEqual(delivered, ["遅れて届いた"]);
    source.stop();
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("source gives up on a recording whose result never arrives", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const delivered = [];
  const logs = [];

  try {
    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: (text) => delivered.push(text),
      // A negative budget makes every recording stale on sight, so the give-up
      // branch runs without waiting out a real timeout.
      freshMs: -60_000,
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    source.start();

    await rec.addEmptyRecording("1793612903");
    source.consider("1793612903");
    source.poll();

    assert.deepEqual(delivered, []);
    assert.ok(
      logs.some((line) => line.startsWith("debug:give up on recording 1793612903")),
      `expected a give-up log, got ${JSON.stringify(logs)}`,
    );
    source.stop();
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("source ignores a stale recording that still has text", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const delivered = [];

  try {
    await rec.addRecording("1793612903", { result: "history floor" });

    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: (text) => delivered.push(text),
      // Negative budget: a file that exists but is old must not be pasted, even
      // though it has text, because it is history rather than new speech.
      freshMs: -60_000,
    });
    source.start();
    // Above the high-water mark, so only the freshness check can reject it.
    await rec.addRecording("1793612904", { result: "古い録音" });
    source.consider("1793612904");

    assert.deepEqual(delivered, []);
    source.stop();
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("source does not start when the recordings folder is missing", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const logs = [];

  try {
    const source = module.createRecordingSource({
      dir: join(tmpdir(), "definitely-not-here-67890"),
      maxChars: () => 8000,
      onText: () => {},
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    source.start();

    assert.equal(source.isRunning(), false);
    assert.ok(
      logs.some((line) => line.startsWith("warn:recordings folder unavailable")),
      `expected an unavailable warning, got ${JSON.stringify(logs)}`,
    );
  } finally {
    await cleanup();
  }
});

test("stop is idempotent and clears running state", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();

  try {
    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: () => {},
    });

    source.stop();
    assert.equal(source.isRunning(), false);

    source.start();
    assert.equal(source.isRunning(), true);

    source.stop();
    source.stop();
    assert.equal(source.isRunning(), false);
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("consider before start is a no-op", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const delivered = [];

  try {
    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: (text) => delivered.push(text),
    });

    await rec.addRecording("1793612906", { result: "早すぎる" });
    source.consider("1793612906");

    assert.deepEqual(delivered, []);
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});

test("a throwing onText does not break the source", async () => {
  const { module, cleanup } = await loadRecordingSource();
  const rec = await makeRecordingsDir();
  const logs = [];
  let calls = 0;

  try {
    const source = module.createRecordingSource({
      dir: rec.dir,
      maxChars: () => 8000,
      onText: () => {
        calls += 1;
        throw new Error("editor went away");
      },
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    source.start();

    await rec.addRecording("1793612907", { result: "失敗しても続く" });
    source.consider("1793612907");

    assert.equal(calls, 1);
    assert.equal(source.isRunning(), true);
    assert.ok(
      logs.some((line) => line.startsWith("error:onText failed")),
      `expected an error log, got ${JSON.stringify(logs)}`,
    );
    source.stop();
  } finally {
    await rec.cleanup();
    await cleanup();
  }
});
