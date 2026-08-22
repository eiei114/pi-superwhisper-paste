import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { promisify } from "node:util";

const extensionUrl = new URL("../extensions/index.ts", import.meta.url);

async function importExtensionFromTypeScript() {
  const source = await readFile(extensionUrl, "utf8");
  const compiled = stripTypeScriptTypes(source, { mode: "strip" });

  const tempDir = await mkdtemp(join(tmpdir(), "pi-superwhisper-paste-test-"));
  const modulePath = join(tempDir, "extension.mjs");
  await writeFile(modulePath, compiled, "utf8");

  return {
    module: await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`),
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

function createPiHarness() {
  const handlers = new Map();
  const commands = new Map();
  return {
    pi: {
      registerCommand(commandName, options) {
        commands.set(commandName, options);
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
    command(commandName) {
      const command = commands.get(commandName);
      assert.equal(typeof command?.handler, "function", `missing command for ${commandName}`);
      return command;
    },
  };
}

function createRuntimeContext() {
  let stale = false;
  let terminalInputHandler;
  let unsubscribeCalled = false;

  const assertFresh = () => {
    if (stale) throw new Error("Pi rejected a stale extension ctx");
  };

  const ui = {
    setStatus() {
      assertFresh();
    },
    notify() {
      assertFresh();
    },
    onTerminalInput(handler) {
      assertFresh();
      terminalInputHandler = handler;
      return () => {
        unsubscribeCalled = true;
      };
    },
    pasteToEditor() {
      assertFresh();
    },
    getEditorText() {
      assertFresh();
      return "";
    },
  };

  return {
    ctx: {
      hasUI: true,
      get ui() {
        assertFresh();
        return ui;
      },
    },
    invalidate() {
      stale = true;
    },
    terminalInput(data) {
      assert.equal(typeof terminalInputHandler, "function", "terminal input handler was not registered");
      return terminalInputHandler(data);
    },
    get unsubscribeCalled() {
      return unsubscribeCalled;
    },
  };
}

test("regression: stale session callbacks do not bubble Pi's stale-ctx guard", async () => {
  // Original failure mode: an old terminal-input callback retained a closed Pi
  // extension ctx. When focus/input arrived later, touching ctx.ui escaped the
  // extension as an uncaughtException from Pi's stale-ctx guard.
  const originalExecFile = childProcess.execFile;
  const originalWrite = process.stdout.write;
  const originalMode = process.env.PI_SUPERWHISPER_PASTE;
  const originalInterval = process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
  const tempModules = [];

  const execFileMock = (_file, _args, _options, callback) => {
    queueMicrotask(() =>
      callback(
        null,
        JSON.stringify({
          text: "clipboard baseline",
          ownerProcessName: "Superwhisper",
          ownerProcessPath: "C:\\Program Files\\Superwhisper\\Superwhisper.exe",
        }),
        "",
      ),
    );
    return { kill() {} };
  };
  execFileMock[promisify.custom] = async () => ({
    stdout: JSON.stringify({
      text: "clipboard baseline",
      ownerProcessName: "Superwhisper",
      ownerProcessPath: "C:\\Program Files\\Superwhisper\\Superwhisper.exe",
    }),
    stderr: "",
  });

  childProcess.execFile = execFileMock;
  syncBuiltinESMExports();

  process.stdout.write = () => true;
  process.env.PI_SUPERWHISPER_PASTE = "on";
  process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = "60000";

  try {
    const imported = await importExtensionFromTypeScript();
    tempModules.push(imported);
    const superwhisperPaste = imported.module.default;

    const harness = createPiHarness();
    superwhisperPaste(harness.pi);
    harness.command("sw-paste:on");
    harness.command("sw-paste:off");

    const runtime = createRuntimeContext();
    await harness.handler("session_start")({}, runtime.ctx);

    runtime.invalidate();
    await harness.handler("session_shutdown")();
    assert.equal(runtime.unsubscribeCalled, true);

    assert.doesNotThrow(() => runtime.terminalInput("\x1b[O"));
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    process.stdout.write = originalWrite;

    if (originalMode === undefined) delete process.env.PI_SUPERWHISPER_PASTE;
    else process.env.PI_SUPERWHISPER_PASTE = originalMode;

    if (originalInterval === undefined) delete process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
    else process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = originalInterval;

    await Promise.all(tempModules.map(({ cleanup }) => cleanup()));
  }
});
