import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extensionSource = await readFile(new URL("../extensions/index.ts", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

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

test("extension status version matches package.json", () => {
  const match = extensionSource.match(/const EXTENSION_VERSION = "([^"]+)"/);
  assert.ok(match, "EXTENSION_VERSION constant is declared in extensions/index.ts");
  assert.equal(
    match[1],
    packageJson.version,
    "EXTENSION_VERSION must stay aligned with package.json for live debugging status text",
  );
});

test("README pinned install example matches package.json", () => {
  const pins = [...readme.matchAll(/pi-superwhisper-paste@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
  assert.ok(pins.length > 0, "README should include a pinned npm install example");
  for (const pin of pins) {
    assert.equal(
      pin,
      packageJson.version,
      "README pinned install examples must match package.json for reproducible installs",
    );
  }
});

test("extension gates clipboard paste to the active terminal tab", () => {
  assert.match(extensionSource, /ENABLE_FOCUS_REPORTING/);
  assert.match(extensionSource, /onTerminalInput/);
  assert.match(extensionSource, /isActiveTab/);
  assert.match(extensionSource, /claimActiveTab/);
});

test("extension suppresses local terminal copy clipboard changes", () => {
  assert.match(extensionSource, /PI_SUPERWHISPER_PASTE_IGNORE_COPY_MS/);
  assert.match(extensionSource, /isLocalCopyShortcut/);
  assert.match(extensionSource, /suppressPasteAfterLocalCopy/);
  assert.match(extensionSource, /shouldSuppressPasteForRecentCopy/);
});

test("extension filters clipboard sources to avoid terminal owners", () => {
  assert.match(extensionSource, /PI_SUPERWHISPER_PASTE_OWNER_DENYLIST/);
  assert.match(extensionSource, /GetClipboardOwner/);
  assert.match(extensionSource, /ownerProcessName/);
  assert.match(extensionSource, /shouldAcceptClipboardSource/);
  assert.match(extensionSource, /windowsterminal/);
});

test("extension keeps pasting while the agent is busy", () => {
  assert.doesNotMatch(extensionSource, /isIdle/);
});

test("extension registers control commands for slash autocomplete", () => {
  assert.match(extensionSource, /registerCommand\("sw-paste:on"/);
  assert.match(extensionSource, /registerCommand\("sw-paste:off"/);
});

test("extension truncates clipboard reads before PowerShell stdout", () => {
  assert.match(extensionSource, /\$limit = \$\{limit\}/);
  assert.match(extensionSource, /Substring\(0, \$limit\)/);
  assert.match(extensionSource, /async function readClipboardSnapshot[\s\S]*catch \{/);
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
