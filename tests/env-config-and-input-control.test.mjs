/**
 * Pins the environment fallback rules and the `/sw-paste:on|off` input path of
 * `extensions/index.ts`.
 *
 * The extension keeps its parsing helpers private, so this suite uses the
 * `transform` seam in `tests/helpers/load-extension.mjs` to append exports and a
 * cache reset to a temporary, type-stripped copy. Production code is untouched.
 * No test here reads the real clipboard or the real Superwhisper recordings
 * folder: clipboard reads go through a mocked `execFile`, and `auto` resolution
 * uses temporary directories supplied via `PI_SUPERWHISPER_PASTE_RECORDINGS_DIR`.
 */

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { loadExtensionModule } from "./helpers/load-extension.mjs";

const extensionUrl = new URL("../extensions/index.ts", import.meta.url);
const extensionSource = await readFile(extensionUrl, "utf8");

const ENV_KEYS = [
  "PI_SUPERWHISPER_PASTE",
  "PI_SUPERWHISPER_PASTE_SOURCE",
  "PI_SUPERWHISPER_PASTE_RECORDINGS_DIR",
  "PI_SUPERWHISPER_PASTE_INTERVAL_MS",
  "PI_SUPERWHISPER_PASTE_MAX_CHARS",
  "PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS",
  "PI_SUPERWHISPER_PASTE_OWNER_DENYLIST",
];

/** Snapshot the env keys this suite mutates; returns a restore callback. */
function snapshotEnv() {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Export the private parsing helpers and add a cache reset, only in the temp
 * copy. Mirrors the instrumentation approach in perf-cache-regression.test.mjs.
 */
function instrumentExtensionSource(source, name) {
  if (name !== "index.ts") return source;
  return `${source}

export {
  state,
  defaultMode,
  configuredSource,
  activeSource,
  runtimeConfig,
  intervalMs,
  maxChars,
  ignoreCopyMs,
  recordingsDir,
  ownerDenylist,
  shouldAcceptClipboardSource,
  parseControlCommand,
  DEFAULT_SOURCE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_CHARS,
  DEFAULT_IGNORE_COPY_MS,
  DEFAULT_OWNER_DENYLIST,
};
export function __resetCaches() {
  cachedRuntimeConfig = undefined;
  cachedOwnerDenylist = undefined;
  cachedOwnerDenylistEnv = undefined;
}
`;
}

async function loadInstrumented() {
  return loadExtensionModule({
    prefix: "pi-superwhisper-paste-env-config",
    transform: instrumentExtensionSource,
  });
}

const extension = await loadInstrumented();
const ext = extension.module;

test("source exposes all documented parsing helpers for instrumentation", () => {
  assert.match(extensionSource, /function defaultMode\(\): BridgeMode/);
  assert.match(extensionSource, /function configuredSource\(\): BridgeSource/);
  assert.match(extensionSource, /function activeSource\(\)/);
  assert.match(extensionSource, /function runtimeConfig\(\): RuntimeConfig/);
  assert.match(extensionSource, /function recordingsDir\(\): string/);
  assert.match(extensionSource, /function ownerDenylist\(\)/);
  assert.match(extensionSource, /function shouldAcceptClipboardSource/);
  assert.match(extensionSource, /function parseControlCommand/);

  for (const name of [
    "defaultMode",
    "configuredSource",
    "activeSource",
    "runtimeConfig",
    "recordingsDir",
    "ownerDenylist",
    "shouldAcceptClipboardSource",
    "parseControlCommand",
    "__resetCaches",
  ]) {
    assert.equal(typeof ext[name], "function", `missing exported helper: ${name}`);
  }
});

test("PI_SUPERWHISPER_PASTE disables the bridge for 0/false/no/off in any case and padding", (t) => {
  t.after(snapshotEnv());

  for (const raw of ["0", "false", "no", "off", "OFF", " Off ", "\tNo\n", "FALSE"]) {
    process.env.PI_SUPERWHISPER_PASTE = raw;
    assert.equal(ext.defaultMode(), "off", `PI_SUPERWHISPER_PASTE=${JSON.stringify(raw)}`);
  }

  // Every other value keeps the bridge on, including empty/whitespace and the
  // implicit default when the variable is absent.
  for (const raw of ["on", "1", "true", "yes", "enabled", "", "   ", "anything"]) {
    process.env.PI_SUPERWHISPER_PASTE = raw;
    assert.equal(ext.defaultMode(), "on", `PI_SUPERWHISPER_PASTE=${JSON.stringify(raw)}`);
  }
  delete process.env.PI_SUPERWHISPER_PASTE;
  assert.equal(ext.defaultMode(), "on", "unset PI_SUPERWHISPER_PASTE defaults to on");
});

test("bridge mode is resolved from PI_SUPERWHISPER_PASTE at load time", async (t) => {
  const restoreEnv = snapshotEnv();
  t.after(restoreEnv);
  const modules = [];
  t.after(async () => {
    await Promise.all(modules.map(({ cleanup }) => cleanup()));
  });

  for (const [raw, expected] of [
    ["off", "off"],
    [" ON ", "on"],
  ]) {
    process.env.PI_SUPERWHISPER_PASTE = raw;
    // Distinct import URLs (the helper appends Date.now()) keep each load fresh.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const loaded = await loadInstrumented();
    modules.push(loaded);
    assert.equal(loaded.module.state.mode, expected, `load with PI_SUPERWHISPER_PASTE=${raw}`);
  }
});

test("PI_SUPERWHISPER_PASTE_SOURCE falls back to clipboard for blank/unknown values", (t) => {
  t.after(snapshotEnv());

  for (const raw of [undefined, "", "   ", "unknown", "garbage"]) {
    if (raw === undefined) delete process.env.PI_SUPERWHISPER_PASTE_SOURCE;
    else process.env.PI_SUPERWHISPER_PASTE_SOURCE = raw;
    assert.equal(
      ext.configuredSource(),
      "clipboard",
      `PI_SUPERWHISPER_PASTE_SOURCE=${JSON.stringify(raw)}`,
    );
  }

  for (const [raw, expected] of [
    ["clipboard", "clipboard"],
    ["recording", "recording"],
    ["auto", "auto"],
    [" AUTO ", "auto"],
    ["Recording", "recording"],
  ]) {
    process.env.PI_SUPERWHISPER_PASTE_SOURCE = raw;
    assert.equal(ext.configuredSource(), expected);
  }
  assert.equal(ext.DEFAULT_SOURCE, "clipboard");
});

test("PI_SUPERWHISPER_PASTE_RECORDINGS_DIR overrides the recordings folder", (t) => {
  t.after(snapshotEnv());

  process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = "  C:\\Temp\\sw-recordings  ";
  assert.equal(ext.recordingsDir(), "C:\\Temp\\sw-recordings");

  delete process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR;
  assert.match(ext.recordingsDir(), /com[.]superwhisper[.]app[\\/]recordings$/);
});

test("source=auto resolves to recording only when the recordings dir exists", async (t) => {
  t.after(snapshotEnv());

  const tempRoot = await mkdtemp(join(tmpdir(), "sw-paste-env-auto-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  process.env.PI_SUPERWHISPER_PASTE_SOURCE = "auto";

  // A path that does not exist must never opt into reading recordings.
  process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = join(tempRoot, "missing");
  assert.equal(ext.activeSource(), "clipboard");

  // Point at a real temp directory (never the user's real recordings folder).
  const existing = await mkdtemp(join(tempRoot, "recordings-"));
  process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = existing;
  assert.equal(ext.activeSource(), "recording");

  // Explicit sources skip the directory check entirely.
  process.env.PI_SUPERWHISPER_PASTE_SOURCE = "recording";
  process.env.PI_SUPERWHISPER_PASTE_RECORDINGS_DIR = join(tempRoot, "missing");
  assert.equal(ext.activeSource(), "recording");
  process.env.PI_SUPERWHISPER_PASTE_SOURCE = "clipboard";
  assert.equal(ext.activeSource(), "clipboard");
});

test("numeric env values fall back on non-numeric/zero/negative, but IGNORE_COPY_MS accepts 0", (t) => {
  const restoreEnv = snapshotEnv();
  t.after(restoreEnv);

  ext.__resetCaches();
  delete process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS;
  delete process.env.PI_SUPERWHISPER_PASTE_MAX_CHARS;
  delete process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS;
  assert.deepEqual(ext.runtimeConfig(), {
    intervalMs: 800,
    maxChars: 8000,
    ignoreCopyMs: 1500,
  });

  const invalidInterval = ["abc", "0", "-5", "   ", "NaN"];
  for (const raw of invalidInterval) {
    ext.__resetCaches();
    process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = raw;
    process.env.PI_SUPERWHISPER_PASTE_MAX_CHARS = raw;
    assert.equal(ext.intervalMs(), 800, `interval=${JSON.stringify(raw)}`);
    assert.equal(ext.maxChars(), 8000, `maxChars=${JSON.stringify(raw)}`);
  }

  ext.__resetCaches();
  process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = "250";
  process.env.PI_SUPERWHISPER_PASTE_MAX_CHARS = "4096";
  assert.equal(ext.intervalMs(), 250);
  assert.equal(ext.maxChars(), 4096);

  // 0 is a valid "do not suppress after copy" setting; negatives are not.
  ext.__resetCaches();
  process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS = "0";
  assert.equal(ext.ignoreCopyMs(), 0);
  ext.__resetCaches();
  process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS = "-1";
  assert.equal(ext.ignoreCopyMs(), 1500);
  ext.__resetCaches();
  process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS = "abc";
  assert.equal(ext.ignoreCopyMs(), 1500);
  ext.__resetCaches();
  process.env.PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS = "275";
  assert.equal(ext.ignoreCopyMs(), 275);

  assert.equal(ext.DEFAULT_INTERVAL_MS, 800);
  assert.equal(ext.DEFAULT_MAX_CHARS, 8000);
  assert.equal(ext.DEFAULT_IGNORE_COPY_MS, 1500);
});

test("polling interval falls back outside Node's timer range", (t) => {
  t.after(snapshotEnv());

  for (const [raw, expected] of [
    ["250", 250],
    ["2147483647", 2_147_483_647],
    ["2147483648", 800],
    ["1", 1],
    ["0.5", 800],
  ]) {
    ext.__resetCaches();
    process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = raw;
    assert.equal(ext.intervalMs(), expected, `interval=${raw}`);
  }
});

test("OWNER_DENYLIST is split/trimmed/lowercased and an all-empty list uses the default", (t) => {
  const restoreEnv = snapshotEnv();
  t.after(restoreEnv);

  ext.__resetCaches();
  delete process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST;
  assert.deepEqual(ext.ownerDenylist(), ext.DEFAULT_OWNER_DENYLIST);

  ext.__resetCaches();
  process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST = " , , \t,";
  assert.deepEqual(ext.ownerDenylist(), ext.DEFAULT_OWNER_DENYLIST);

  ext.__resetCaches();
  process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST = "Terminal,  POWERshell ,code,";
  assert.deepEqual(ext.ownerDenylist(), ["terminal", "powershell", "code"]);

  // Cache is keyed on the raw env value, so a new value recomputes the list.
  process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST = "bash,wsl";
  assert.deepEqual(ext.ownerDenylist(), ["bash", "wsl"]);
});

test("clipboard owner gate uses denylist substrings; empty owner is accepted", (t) => {
  const restoreEnv = snapshotEnv();
  t.after(restoreEnv);

  ext.__resetCaches();
  process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST = "terminal, evil";

  assert.equal(
    ext.shouldAcceptClipboardSource({
      ownerProcessName: "WindowsTerminal.exe",
      ownerProcessPath: "C:\\Windows\\System32\\WindowsTerminal.exe",
    }),
    false,
    "denylisted process name is rejected",
  );
  assert.equal(
    ext.shouldAcceptClipboardSource({
      ownerProcessName: "notepad",
      ownerProcessPath: "C:\\Tools\\Terminal\\notepad.exe",
    }),
    false,
    "denylisted token anywhere in the path is rejected",
  );
  assert.equal(
    ext.shouldAcceptClipboardSource({
      ownerProcessName: "Superwhisper",
      ownerProcessPath: "C:\\Program Files\\Superwhisper\\superwhisper.exe",
    }),
    true,
    "Superwhisper itself is accepted",
  );
  assert.equal(ext.shouldAcceptClipboardSource({}), true, "empty owner is accepted");
  assert.equal(
    ext.shouldAcceptClipboardSource({ ownerProcessName: "  ", ownerProcessPath: "" }),
    true,
    "whitespace-only owner is accepted",
  );

  // Documents current behaviour (possible follow-up, not a behaviour change):
  // a short token such as `code` matches unrelated directory names in a path.
  ext.__resetCaches();
  process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST = "code";
  assert.equal(
    ext.shouldAcceptClipboardSource({
      ownerProcessName: "superwhisper.exe",
      ownerProcessPath: "C:\\Users\\code\\superwhisper.exe",
    }),
    false,
    "current behaviour: path substring match rejects even a Superwhisper owner",
  );
});

test("parseControlCommand accepts only exact /sw-paste:on|off", () => {
  assert.equal(ext.parseControlCommand("/sw-paste:off"), "off");
  assert.equal(ext.parseControlCommand("/sw-paste:on"), "on");
  assert.equal(ext.parseControlCommand(" /SW-PASTE:OFF "), "off");
  assert.equal(ext.parseControlCommand("\t/sw-paste:On\n"), "on");

  for (const text of ["/sw-paste:onx", "/sw-paste:on extra", "", "hello", "/sw-paste:", "sw-paste:off"]) {
    assert.equal(ext.parseControlCommand(text), undefined, `unexpected control match: ${JSON.stringify(text)}`);
  }
});

function createPiHarness() {
  const handlers = new Map();
  const commands = new Map();
  return {
    pi: {
      registerCommand(name, definition) {
        commands.set(name, definition);
      },
      on(eventName, handler) {
        handlers.set(eventName, handler);
      },
    },
    commands,
    handler(eventName) {
      const handler = handlers.get(eventName);
      assert.equal(typeof handler, "function", `missing handler for ${eventName}`);
      return handler;
    },
  };
}

function createCtx() {
  return {
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
}

test("input event handles on/off and continues on any other text", async (t) => {
  const restoreEnv = snapshotEnv();
  t.after(restoreEnv);

  const originalExecFile = childProcess.execFile;
  const originalWrite = process.stdout.write;
  const modules = [];
  t.after(async () => {
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    process.stdout.write = originalWrite;
    await Promise.all(modules.map(({ cleanup }) => cleanup()));
  });

  // Stub clipboard reads so the extension never touches the real clipboard.
  const execFileMock = (_file, _args, _options, callback) => {
    queueMicrotask(() =>
      callback(null, JSON.stringify({ text: "baseline" }), ""),
    );
    return { kill() {} };
  };
  execFileMock[promisify.custom] = async () => ({
    stdout: JSON.stringify({ text: "baseline" }),
    stderr: "",
  });
  childProcess.execFile = execFileMock;
  syncBuiltinESMExports();
  // Swallow the extension's terminal escape writes; keep the test runner's output.
  process.stdout.write = (chunk, ...rest) =>
    typeof chunk === "string" && chunk.startsWith("\x1b")
      ? true
      : originalWrite.call(process.stdout, chunk, ...rest);

  process.env.PI_SUPERWHISPER_PASTE = "on";
  // Long interval: no poll ticks (and no clipboard reads) during this test.
  process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS = "60000";
  await new Promise((resolve) => setTimeout(resolve, 5));
  const loaded = await loadInstrumented();
  modules.push(loaded);

  const harness = createPiHarness();
  loaded.module.default(harness.pi);
  const ctx = createCtx();

  assert.ok(harness.commands.has("sw-paste:on"));
  assert.ok(harness.commands.has("sw-paste:off"));

  await harness.handler("session_start")({}, ctx);
  assert.equal(loaded.module.state.mode, "on");
  assert.ok(loaded.module.state.interval, "polling should be active after session_start");

  // off: handled, polling disabled.
  assert.deepEqual(
    await harness.handler("input")({ text: " /SW-PASTE:OFF " }, ctx),
    { action: "handled" },
  );
  assert.equal(loaded.module.state.mode, "off");
  assert.equal(loaded.module.state.interval, undefined);

  // on: handled, polling re-enabled.
  assert.deepEqual(
    await harness.handler("input")({ text: "/sw-paste:on" }, ctx),
    { action: "handled" },
  );
  assert.equal(loaded.module.state.mode, "on");
  assert.ok(loaded.module.state.interval, "polling should resume after /sw-paste:on");

  // Any other text continues without changing state.
  for (const text of ["/sw-paste:onx", "/sw-paste:on extra", "hello", ""]) {
    assert.deepEqual(
      await harness.handler("input")({ text }, ctx),
      { action: "continue" },
      `unexpected handling for ${JSON.stringify(text)}`,
    );
  }
  assert.equal(loaded.module.state.mode, "on");

  // Plain, exact off is handled too.
  assert.deepEqual(
    await harness.handler("input")({ text: "/sw-paste:off" }, ctx),
    { action: "handled" },
  );
  assert.equal(loaded.module.state.mode, "off");

  await harness.handler("session_shutdown")();
});
