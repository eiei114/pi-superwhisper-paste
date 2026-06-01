import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extensionSource = await readFile(new URL("../extensions/index.ts", import.meta.url), "utf8");

test("package declares pi resources", () => {
  assert.deepEqual(packageJson.pi.extensions, ["./extensions"]);
  assert.equal(packageJson.pi.skills, undefined);
  assert.equal(packageJson.pi.prompts, undefined);
  assert.equal(packageJson.pi.themes, undefined);
});

test("package is discoverable as a Pi package", () => {
  assert.ok(packageJson.keywords.includes("pi-package"));
});

test("package uses public publish config", () => {
  assert.equal(packageJson.publishConfig.access, "public");
});

test("package metadata points at the OSS repository", () => {
  assert.equal(packageJson.name, "pi-superwhisper-paste");
  assert.equal(
    packageJson.repository.url,
    "git+https://github.com/eiei114/pi-superwhisper-paste.git",
  );
});

test("extension gates clipboard paste to the active terminal tab", () => {
  assert.match(extensionSource, /ENABLE_FOCUS_REPORTING/);
  assert.match(extensionSource, /onTerminalInput/);
  assert.match(extensionSource, /isActiveTab/);
  assert.match(extensionSource, /claimActiveTab/);
});

test("extension keeps pasting while the agent is busy", () => {
  assert.doesNotMatch(extensionSource, /isIdle/);
});

test("extension registers control commands for slash autocomplete", () => {
  assert.match(extensionSource, /registerCommand\("sw-paste:on"/);
  assert.match(extensionSource, /registerCommand\("sw-paste:off"/);
});

test("extension guards stale session callbacks before touching Pi UI", () => {
  assert.match(extensionSource, /type SessionHandle/);
  assert.match(extensionSource, /function isCurrentSession/);
  assert.match(extensionSource, /function safeWithCurrentUi/);
  assert.match(extensionSource, /function beginSession[\s\S]*teardownSessionResources/);
  assert.match(
    extensionSource,
    /onTerminalInput\(\(\s*\w+\s*\)\s*=>\s*\{\s*if\s*\(!isCurrentSession\(\w+,\s*\w+\)\)\s*return undefined;/,
  );
  assert.match(
    extensionSource,
    /setInterval\(\(\)\s*=>\s*\{\s*if\s*\(isCurrentSession\(\w+,\s*\w+\)\)\s*void pasteClipboardChange\(\w+,\s*\w+\);/,
  );
  assert.doesNotMatch(extensionSource, /state\.ctx/);
});
