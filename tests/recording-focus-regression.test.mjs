import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadExtensionModule } from "./helpers/load-extension.mjs";

function createPiHarness() {
  const handlers = new Map();
  const commands = new Map();
  return {
    pi: {
      registerCommand(name, options) {
        commands.set(name, options);
      },
      on(eventName, handler) {
        handlers.set(eventName, handler);
      },
    },
    handler(eventName) {
      const handler = handlers.get(eventName);
      assert.equal(typeof handler, "function", `missing handler for ${eventName}`);
      return handler;
    },
    command(name) {
      const command = commands.get(name);
      assert.equal(typeof command?.handler, "function", `missing command for ${name}`);
      return command;
    },
  };
}

function createRuntimeContext() {
  const pasted = [];
  const statuses = [];
  const ui = {
    setStatus(key, value) {
      statuses.push([key, value]);
    },
    notify() {},
    onTerminalInput() {
      return () => {};
    },
    pasteToEditor(text) {
      pasted.push(text);
    },
    getEditorText() {
      return "";
    },
  };

  return {
    ctx: { hasUI: true, ui },
    pasted,
    statuses,
  };
}

/**
 * Builds an execFile stub that answers `herdr-app status` with `focusedTerminal`
 * and never answers clipboard reads. The recording source does not use the
 * clipboard, so silence there is the point.
 */
function stubExecFile(focusedTerminal) {
  const mock = (_file, args, _options, callback) => {
    const statusCall = Array.isArray(args) && args[0] === "status";
    queueMicrotask(() => {
      if (statusCall) {
        callback(null, JSON.stringify({ agent: focusedTerminal, focused_pane: "p1" }), "");
        return;
      }
      callback(null, JSON.stringify({ text: "" }), "");
    });
    return { kill() {} };
  };

  mock[promisify.custom] = async (_file, args) => {
    const statusCall = Array.isArray(args) && args[0] === "status";
    return {
      stdout: statusCall
        ? JSON.stringify({ agent: focusedTerminal, focused_pane: "p1" })
        : JSON.stringify({ text: "" }),
      stderr: "",
    };
  };

  return mock;
}

async function makeRecordings() {
  const dir = await mkdtemp(join(tmpdir(), "sw-rec-focus-"));

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    async add(id, text) {
      const folder = join(dir, String(id));
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "meta.json"), JSON.stringify({ result: text }), "utf8");
    },
  };
}

/** Polls until `check()` is true or the budget runs out. */
async function waitFor(check, budgetMs = 3_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("recording paste lands only in the Herdr-focused pane", async () => {
  // Original failure mode: every Pi session watched the same recordings folder
  // and pasted unconditionally, so one dictation appeared in every open session.
  const originalExecFile = childProcess.execFile;
  const originalGlobals = {
    localAppData: process.env.LOCALAPPDATA,
    terminalId: process.env.HC_TERMINAL_ID,
    recordings: process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR,
    source: process.env.PI_SUPERWHISPER_PASTE_SOURCE,
    mode: process.env.PI_SUPERWHISPER_PASTE,
  };

  const rec = await makeRecordings();
  const loaded = [];

  try {
    // This process claims to be t1n; Herdr reports t2n as focused, so the
    // dictation must be refused here.
    process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = rec.dir;
    process.env.PI_SUPERWHISPER_PASTE_SOURCE = "recording";
    process.env.PI_SUPERWHISPER_PASTE = "on";
    process.env.HC_TERMINAL_ID = "t1n";

    childProcess.execFile = stubExecFile("t2n");
    syncBuiltinESMExports();

    const { module, cleanup } = await loadExtensionModule({ prefix: "sw-focus" });
    loaded.push(cleanup);

    const harness = createPiHarness();
    module.default(harness.pi);

    const runtime = createRuntimeContext();
    await harness.handler("session_start")({ reason: "startup" }, runtime.ctx);

    await rec.add(Date.now(), "フォーカスされていないセッション");
    // Give the watcher and the focus check time to run.
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert.deepEqual(runtime.pasted, [], "a non-focused pane must not receive the text");
    assert.ok(
      runtime.statuses.some(([, value]) => typeof value === "string" && value.includes("skipped")),
      `expected a skip status, got ${JSON.stringify(runtime.statuses)}`,
    );

    await harness.handler("session_shutdown")();
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    process.env.LOCALAPPDATA = originalGlobals.localAppData ?? "";
    if (originalGlobals.localAppData === undefined) delete process.env.LOCALAPPDATA;
    if (originalGlobals.terminalId === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = originalGlobals.terminalId;
    if (originalGlobals.recordings === undefined) delete process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR;
    else process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = originalGlobals.recordings;
    if (originalGlobals.source === undefined) delete process.env.PI_SUPERWHISPER_PASTE_SOURCE;
    else process.env.PI_SUPERWHISPER_PASTE_SOURCE = originalGlobals.source;
    if (originalGlobals.mode === undefined) delete process.env.PI_SUPERWHISPER_PASTE;
    else process.env.PI_SUPERWHISPER_PASTE = originalGlobals.mode;

    for (const cleanup of loaded) await cleanup();
    await rec.cleanup();
  }
});

test("default source stays on clipboard when a recordings folder exists", async () => {
  const originalExecFile = childProcess.execFile;
  const originalGlobals = {
    terminalId: process.env.HC_TERMINAL_ID,
    recordings: process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR,
    source: process.env.PI_SUPERWHISPER_PASTE_SOURCE,
    mode: process.env.PI_SUPERWHISPER_PASTE,
    interval: process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS,
  };

  const rec = await makeRecordings();
  const loaded = [];
  let harness;
  let clipboard = "baseline";

  try {
    process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = rec.dir;
    delete process.env.PI_SUPERWHISPER_PASTE_SOURCE;
    process.env.PI_SUPERWHISPER_PASTE = "on";
    process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = "20";
    delete process.env.HC_TERMINAL_ID;

    const mockExecFile = (_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, JSON.stringify({ text: clipboard }), ""));
      return { kill() {} };
    };
    mockExecFile[promisify.custom] = async () => ({
      stdout: JSON.stringify({ text: clipboard }),
      stderr: "",
    });
    childProcess.execFile = mockExecFile;
    syncBuiltinESMExports();

    const { module, cleanup } = await loadExtensionModule({ prefix: "sw-default-source" });
    loaded.push(cleanup);

    harness = createPiHarness();
    module.default(harness.pi);

    const runtime = createRuntimeContext();
    await harness.handler("session_start")({ reason: "startup" }, runtime.ctx);

    assert.ok(
      runtime.statuses.some(([, value]) => value?.includes("clipboard")),
      `expected clipboard status, got ${JSON.stringify(runtime.statuses)}`,
    );

    clipboard = "clipboard dictation";
    assert.ok(await waitFor(() => runtime.pasted.length === 1), "clipboard update was not pasted");
    assert.deepEqual(runtime.pasted, ["clipboard dictation"]);
  } finally {
    if (harness) await harness.handler("session_shutdown")();
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    if (originalGlobals.terminalId === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = originalGlobals.terminalId;
    if (originalGlobals.recordings === undefined) delete process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR;
    else process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = originalGlobals.recordings;
    if (originalGlobals.source === undefined) delete process.env.PI_SUPERWHISPER_PASTE_SOURCE;
    else process.env.PI_SUPERWHISPER_PASTE_SOURCE = originalGlobals.source;
    if (originalGlobals.mode === undefined) delete process.env.PI_SUPERWHISPER_PASTE;
    else process.env.PI_SUPERWHISPER_PASTE = originalGlobals.mode;
    if (originalGlobals.interval === undefined) delete process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
    else process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = originalGlobals.interval;

    for (const cleanup of loaded) await cleanup();
    await rec.cleanup();
  }
});

test("recording paste lands in the Herdr-focused pane", async () => {
  const originalExecFile = childProcess.execFile;
  const originalGlobals = {
    terminalId: process.env.HC_TERMINAL_ID,
    recordings: process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR,
    source: process.env.PI_SUPERWHISPER_PASTE_SOURCE,
    mode: process.env.PI_SUPERWHISPER_PASTE,
  };

  const rec = await makeRecordings();
  const loaded = [];

  try {
    process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = rec.dir;
    process.env.PI_SUPERWHISPER_PASTE_SOURCE = "recording";
    process.env.PI_SUPERWHISPER_PASTE = "on";
    process.env.HC_TERMINAL_ID = "t1n";

    childProcess.execFile = stubExecFile("t1n");
    syncBuiltinESMExports();

    const { module, cleanup } = await loadExtensionModule({ prefix: "sw-focus-on" });
    loaded.push(cleanup);

    const harness = createPiHarness();
    module.default(harness.pi);

    const runtime = createRuntimeContext();
    await harness.handler("session_start")({ reason: "startup" }, runtime.ctx);

    await rec.add(Date.now(), "フォーカス中のセッション");
    const arrived = await waitFor(() => runtime.pasted.length > 0);

    assert.ok(arrived, `expected the text to arrive, got ${JSON.stringify(runtime.pasted)}`);
    assert.deepEqual(runtime.pasted, ["フォーカス中のセッション"]);

    await harness.handler("session_shutdown")();
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    if (originalGlobals.terminalId === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = originalGlobals.terminalId;
    if (originalGlobals.recordings === undefined) delete process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR;
    else process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = originalGlobals.recordings;
    if (originalGlobals.source === undefined) delete process.env.PI_SUPERWHISPER_PASTE_SOURCE;
    else process.env.PI_SUPERWHISPER_PASTE_SOURCE = originalGlobals.source;
    if (originalGlobals.mode === undefined) delete process.env.PI_SUPERWHISPER_PASTE;
    else process.env.PI_SUPERWHISPER_PASTE = originalGlobals.mode;

    for (const cleanup of loaded) await cleanup();
    await rec.cleanup();
  }
});

test("dictating the same words twice pastes both recordings", async () => {
  // Each recording id is delivered once by the source; a same-text guard on
  // top of that dropped a genuine second "yes".
  const originalExecFile = childProcess.execFile;
  const originalGlobals = {
    terminalId: process.env.HC_TERMINAL_ID,
    recordings: process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR,
    source: process.env.PI_SUPERWHISPER_PASTE_SOURCE,
    mode: process.env.PI_SUPERWHISPER_PASTE,
  };

  const rec = await makeRecordings();
  const loaded = [];

  try {
    process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = rec.dir;
    process.env.PI_SUPERWHISPER_PASTE_SOURCE = "recording";
    process.env.PI_SUPERWHISPER_PASTE = "on";
    process.env.HC_TERMINAL_ID = "t1n";

    childProcess.execFile = stubExecFile("t1n");
    syncBuiltinESMExports();

    const { module, cleanup } = await loadExtensionModule({ prefix: "sw-focus-repeat" });
    loaded.push(cleanup);

    const harness = createPiHarness();
    module.default(harness.pi);

    const runtime = createRuntimeContext();
    await harness.handler("session_start")({ reason: "startup" }, runtime.ctx);

    const first = Date.now();
    await rec.add(first, "yes");
    assert.ok(await waitFor(() => runtime.pasted.length === 1), `first: ${JSON.stringify(runtime.pasted)}`);
    await rec.add(first + 1000, "yes");
    assert.ok(await waitFor(() => runtime.pasted.length === 2), `second: ${JSON.stringify(runtime.pasted)}`);
    assert.deepEqual(runtime.pasted, ["yes", "yes"]);

    await harness.handler("session_shutdown")();
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    if (originalGlobals.terminalId === undefined) delete process.env.HC_TERMINAL_ID;
    else process.env.HC_TERMINAL_ID = originalGlobals.terminalId;
    if (originalGlobals.recordings === undefined) delete process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR;
    else process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = originalGlobals.recordings;
    if (originalGlobals.source === undefined) delete process.env.PI_SUPERWHISPER_PASTE_SOURCE;
    else process.env.PI_SUPERWHISPER_PASTE_SOURCE = originalGlobals.source;
    if (originalGlobals.mode === undefined) delete process.env.PI_SUPERWHISPER_PASTE;
    else process.env.PI_SUPERWHISPER_PASTE = originalGlobals.mode;

    for (const cleanup of loaded) await cleanup();
    await rec.cleanup();
  }
});
