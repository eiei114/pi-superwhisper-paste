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
const extensionSource = await readFile(extensionUrl, "utf8");

async function importExtensionFromTypeScript() {
  const source = await readFile(extensionUrl, "utf8");
  const compiled = stripTypeScriptTypes(source, { mode: "strip" });

  const tempDir = await mkdtemp(join(tmpdir(), "pi-superwhisper-paste-perf-"));
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

test("extension caches clipboard poll hot-path helpers", () => {
  assert.match(extensionSource, /function clipboardPowerShellCommand/);
  assert.match(extensionSource, /let cachedClipboardScript/);
  assert.match(extensionSource, /let cachedOwnerDenylist/);
  assert.match(extensionSource, /function invalidateActiveTabCache/);
  assert.match(extensionSource, /state\.activeTabCache/);
});

test("regression: repeated clipboard reads reuse the cached PowerShell command", async () => {
  const originalExecFile = childProcess.execFile;
  const originalWrite = process.stdout.write;
  const originalMode = process.env.PI_SUPERWHISPER_PASTE;
  const originalInterval = process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
  const tempModules = [];

  const commands = [];
  const execFileMock = (_file, args, _options, callback) => {
    commands.push(args?.[2]);
    queueMicrotask(() =>
      callback(
        null,
        JSON.stringify({
          text: "baseline",
          ownerProcessName: "Superwhisper",
          ownerProcessPath: "C:\\Program Files\\Superwhisper\\Superwhisper.exe",
        }),
        "",
      ),
    );
    return { kill() {} };
  };
  execFileMock[promisify.custom] = async (_file, args) => {
    commands.push(args?.[2]);
    return {
      stdout: JSON.stringify({
        text: "baseline",
        ownerProcessName: "Superwhisper",
        ownerProcessPath: "C:\\Program Files\\Superwhisper\\Superwhisper.exe",
      }),
      stderr: "",
    };
  };

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

    const ctx = {
      hasUI: true,
      ui: {
        setStatus() {},
        notify() {},
        onTerminalInput() {
          return () => {};
        },
        pasteToEditor() {},
        getEditorText() {
          return "";
        },
      },
    };

    await harness.handler("session_start")({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 90));
    await harness.handler("session_shutdown")();

    assert.ok(commands.length >= 2, "expected multiple clipboard reads during polling");
    assert.equal(
      commands[0],
      commands[1],
      "clipboard poll should reuse the cached PowerShell command string",
    );
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
