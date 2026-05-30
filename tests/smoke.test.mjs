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