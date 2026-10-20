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

  const tempDir = await mkdtemp(join(tmpdir(), "pi-superwhisper-paste-maxbuffer-"));
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

test("regression: oversized clipboard stdout does not break session_start", async () => {
  const originalExecFile = childProcess.execFile;
  const originalWrite = process.stdout.write;
  const originalMode = process.env.PI_SUPERWHISPER_PASTE;
  const tempModules = [];

  const maxBufferError = new Error("stdout maxBuffer length exceeded");
  maxBufferError.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

  const execFileMock = (_file, _args, _options, callback) => {
    queueMicrotask(() => callback(maxBufferError));
    return { kill() {} };
  };
  execFileMock[promisify.custom] = async () => {
    throw maxBufferError;
  };

  childProcess.execFile = execFileMock;
  syncBuiltinESMExports();
  process.stdout.write = () => true;
  process.env.PI_SUPERWHISPER_PASTE = "on";

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

    await assert.doesNotReject(async () => {
      await harness.handler("session_start")({}, ctx);
      await harness.handler("session_shutdown")();
    });
  } finally {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    process.stdout.write = originalWrite;

    if (originalMode === undefined) delete process.env.PI_SUPERWHISPER_PASTE;
    else process.env.PI_SUPERWHISPER_PASTE = originalMode;

    await Promise.all(tempModules.map(({ cleanup }) => cleanup()));
  }
});

test("regression: malformed clipboard JSON does not stop startup or later polling", async () => {
  const originalExecFile = childProcess.execFile;
  const originalWrite = process.stdout.write;
  const originalMode = process.env.PI_SUPERWHISPER_PASTE;
  const originalInterval = process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
  const originalTemp = new Map(["TMP", "TEMP", "TMPDIR"].map((key) => [key, process.env[key]]));
  const tempModules = [];
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-superwhisper-paste-malformed-"));
  const pasted = [];
  let reads = 0;
  let harness;
  let sessionStarted = false;

  const stdoutForRead = () => {
    reads += 1;
    if (reads === 1) return "not-json";
    if (reads === 2) {
      return JSON.stringify({
        text: "clipboard baseline",
        ownerProcessName: "Superwhisper",
        ownerProcessPath: "C:\\Program Files\\Superwhisper\\Superwhisper.exe",
      });
    }
    return JSON.stringify({
      text: "dictated after malformed output",
      ownerProcessName: "Superwhisper",
      ownerProcessPath: "C:\\Program Files\\Superwhisper\\Superwhisper.exe",
    });
  };
  const execFileMock = (_file, _args, _options, callback) => {
    queueMicrotask(() => callback(null, stdoutForRead(), ""));
    return { kill() {} };
  };
  execFileMock[promisify.custom] = async () => ({ stdout: stdoutForRead(), stderr: "" });

  childProcess.execFile = execFileMock;
  syncBuiltinESMExports();
  process.stdout.write = () => true;
  process.env.PI_SUPERWHISPER_PASTE = "on";
  process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = "20";
  process.env.TMP = tempRoot;
  process.env.TEMP = tempRoot;
  process.env.TMPDIR = tempRoot;

  try {
    const imported = await importExtensionFromTypeScript();
    tempModules.push(imported);
    harness = createPiHarness();
    imported.module.default(harness.pi);

    const ctx = {
      hasUI: true,
      ui: {
        setStatus() {},
        notify() {},
        onTerminalInput() {
          return () => {};
        },
        pasteToEditor(text) {
          pasted.push(text);
        },
        getEditorText() {
          return pasted.join("");
        },
      },
    };

    await assert.doesNotReject(
      harness.handler("session_start")({}, ctx),
      "malformed PowerShell JSON must not abort Pi session startup",
    );
    sessionStarted = true;

    const deadline = Date.now() + 1000;
    while (pasted.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.ok(reads >= 3, "expected startup, baseline refresh, and a later clipboard poll");
    assert.deepEqual(pasted, ["dictated after malformed output"]);
  } finally {
    try {
      if (sessionStarted) await harness.handler("session_shutdown")();
    } finally {
      childProcess.execFile = originalExecFile;
      syncBuiltinESMExports();
      process.stdout.write = originalWrite;

      if (originalMode === undefined) delete process.env.PI_SUPERWHISPER_PASTE;
      else process.env.PI_SUPERWHISPER_PASTE = originalMode;

      if (originalInterval === undefined) delete process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
      else process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = originalInterval;

      for (const [key, value] of originalTemp) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

      await Promise.all(tempModules.map(({ cleanup }) => cleanup()));
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});
