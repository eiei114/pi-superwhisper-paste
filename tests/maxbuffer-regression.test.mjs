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
