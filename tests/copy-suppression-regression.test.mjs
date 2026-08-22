import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const extensionUrl = new URL("../extensions/index.ts", import.meta.url);

async function importExtensionFromTypeScript() {
  const source = await readFile(extensionUrl, "utf8");
  const compiled = stripTypeScriptTypes(source, { mode: "strip" });

  const tempDir = await mkdtemp(join(tmpdir(), "pi-superwhisper-paste-copy-"));
  const modulePath = join(tempDir, "extension.mjs");
  await writeFile(modulePath, compiled, "utf8");

  return {
    module: await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`),
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

function createPiHarness() {
  const handlers = new Map();
  return {
    pi: {
      registerCommand() {},
      on(eventName, handler) {
        handlers.set(eventName, handler);
      },
    },
    handler(eventName) {
      const handler = handlers.get(eventName);
      assert.equal(typeof handler, "function", `missing handler for ${eventName}`);
      return handler;
    },
  };
}

function createRuntimeContext(pasted) {
  let terminalInputHandler;

  return {
    ctx: {
      hasUI: true,
      ui: {
        setStatus() {},
        notify() {},
        onTerminalInput(handler) {
          terminalInputHandler = handler;
          return () => {};
        },
        pasteToEditor(text) {
          pasted.push(text);
        },
        getEditorText() {
          return pasted.join("");
        },
      },
    },
    terminalInput(data) {
      assert.equal(typeof terminalInputHandler, "function", "terminal input handler was not registered");
      return terminalInputHandler(data);
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("regression: local terminal copy does not auto-paste into Pi", async () => {
  const originalExecFile = childProcess.execFile;
  const originalWrite = process.stdout.write;
  const originalMode = process.env.PI_SUPERWHISPER_PASTE;
  const originalInterval = process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
  const originalIgnoreCopy = process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS;
  const tempModules = [];

  let clipboardSnapshot = {
    text: "baseline",
    ownerProcessName: "Superwhisper",
    ownerProcessPath: "C:\\Program Files\\Superwhisper\\Superwhisper.exe",
  };
  const pasted = [];

  const execFileMock = (_file, _args, _options, callback) => {
    queueMicrotask(() => callback(null, JSON.stringify(clipboardSnapshot), ""));
    return { kill() {} };
  };
  execFileMock[promisify.custom] = async () => ({
    stdout: JSON.stringify(clipboardSnapshot),
    stderr: "",
  });

  childProcess.execFile = execFileMock;
  syncBuiltinESMExports();
  process.stdout.write = () => true;
  process.env.PI_SUPERWHISPER_PASTE = "on";
  process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = "25";
  process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS = "80";

  try {
    const imported = await importExtensionFromTypeScript();
    tempModules.push(imported);
    const superwhisperPaste = imported.module.default;

    const harness = createPiHarness();
    superwhisperPaste(harness.pi);

    const runtime = createRuntimeContext(pasted);
    await harness.handler("session_start")({}, runtime.ctx);

    clipboardSnapshot = {
      text: "copied from active cli",
      ownerProcessName: "WindowsTerminal",
      ownerProcessPath:
        "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\WindowsTerminal.exe",
    };
    await wait(140);
    assert.deepEqual(pasted, []);

    clipboardSnapshot = {
      text: "copied from active cli 2",
      ownerProcessName: "WindowsTerminal",
      ownerProcessPath:
        "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\WindowsTerminal.exe",
    };
    runtime.terminalInput("\x03");
    await wait(140);
    assert.deepEqual(pasted, []);

    clipboardSnapshot = {
      text: "dictated by superwhisper",
      ownerProcessName: "Superwhisper",
      ownerProcessPath: "C:\\Program Files\\Superwhisper\\Superwhisper.exe",
    };
    await wait(140);
    assert.deepEqual(pasted, ["dictated by superwhisper"]);

    await harness.handler("session_shutdown")();
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    process.stdout.write = originalWrite;

    if (originalMode === undefined) delete process.env.PI_SUPERWHISPER_PASTE;
    else process.env.PI_SUPERWHISPER_PASTE = originalMode;

    if (originalInterval === undefined) delete process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
    else process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = originalInterval;

    if (originalIgnoreCopy === undefined) delete process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS;
    else process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS = originalIgnoreCopy;

    await Promise.all(tempModules.map(({ cleanup }) => cleanup()));
  }
});

test("regression: Code host owner is blocked by terminal denylist", async () => {
  const originalExecFile = childProcess.execFile;
  const originalWrite = process.stdout.write;
  const originalMode = process.env.PI_SUPERWHISPER_PASTE;
  const originalInterval = process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
  const tempModules = [];

  let clipboardSnapshot = {
    text: "baseline",
    ownerProcessName: "Code",
    ownerProcessPath: "C:\\Users\\Keisu\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
  };
  const pasted = [];

  const execFileMock = (_file, _args, _options, callback) => {
    queueMicrotask(() => callback(null, JSON.stringify(clipboardSnapshot), ""));
    return { kill() {} };
  };
  execFileMock[promisify.custom] = async () => ({
    stdout: JSON.stringify(clipboardSnapshot),
    stderr: "",
  });

  childProcess.execFile = execFileMock;
  syncBuiltinESMExports();
  process.stdout.write = () => true;
  process.env.PI_SUPERWHISPER_PASTE = "on";
  process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = "25";

  try {
    const imported = await importExtensionFromTypeScript();
    tempModules.push(imported);
    const superwhisperPaste = imported.module.default;

    const harness = createPiHarness();
    superwhisperPaste(harness.pi);

    const runtime = createRuntimeContext(pasted);
    await harness.handler("session_start")({}, runtime.ctx);

    clipboardSnapshot = {
      text: "dictated by superwhisper in code host",
      ownerProcessName: "Code",
      ownerProcessPath: "C:\\Users\\Keisu\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
    };

    await wait(140);
    assert.deepEqual(pasted, []);

    await harness.handler("session_shutdown")();
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
