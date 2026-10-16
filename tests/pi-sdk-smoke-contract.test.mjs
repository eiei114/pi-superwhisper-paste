import assert from "node:assert/strict";
import test from "node:test";
import {
  behaviorAssertions,
  combineReloadCleanup,
  parseJsonLines,
  SDK_VERSIONS,
  VERIFICATION_CONTRACT,
} from "../scripts/pi-sdk-smoke-contract.mjs";

const commandList = {
  type: "response",
  command: "get_commands",
  success: true,
  data: { commands: [{ name: "sw-paste:on" }, { name: "sw-paste:off" }] },
};
const prompt = {
  type: "response",
  command: "prompt",
  success: true,
  data: { disposition: "handled" },
};
const notification = {
  type: "extension_ui_request",
  method: "notify",
  message: "Superwhisper paste bridge: disabled",
};
const malformedRpc = { type: "response", command: "parse", success: false, error: "Invalid JSON" };
const observed = (responses = [commandList, prompt, notification], fullOutput = "", exit_code = 0) => ({
  responses,
  fullOutput,
  exit_code,
  expectedSdkVersion: SDK_VERSIONS["@earendil-works/pi-coding-agent"],
});

test("behavior contract and line-delimited JSON parsing", () => {
  assert.equal(VERIFICATION_CONTRACT, "pi-sdk-behavior-v2");
  assert.deepEqual(parseJsonLines(`not-json\r\n${JSON.stringify(prompt)}\n\n`), [prompt]);
});

test("actual extension registration must match both listed extension commands", () => {
  assert.equal(behaviorAssertions("extension_load", observed([commandList]))[0].passed, true);
  for (const invalid of [
    [],
    [{ ...commandList, success: false }],
    [{ ...commandList, data: { commands: [{ name: "sw-paste:on" }] } }],
  ]) {
    assert.equal(behaviorAssertions("extension_load", observed(invalid))[0].passed, false);
  }
});

test("feature response requires handled RPC and actual disabled notification", () => {
  assert.equal(behaviorAssertions("happy_path", observed())[0].passed, true);
  for (const invalid of [
    [],
    [commandList, { ...prompt, success: false }, notification],
    [commandList, { ...prompt, data: { disposition: "queued" } }, notification],
    [commandList, prompt],
  ]) {
    assert.equal(behaviorAssertions("happy_path", observed(invalid))[0].passed, false);
  }
});

test("reload requires second-host registration, feature response, and clean process exit", () => {
  const assertions = behaviorAssertions("reload_cleanup", observed([commandList, prompt, notification]));
  assert.deepEqual(assertions.map((item) => item.id), [
    "reloaded_extension_registered", "reloaded_feature_response", "clean_shutdown",
  ]);
  assert.ok(assertions.every((item) => item.passed));
  for (const invalid of [
    [],
    [prompt, notification],
    [commandList],
    [commandList, prompt],
    [commandList, notification],
  ]) {
    assert.ok(behaviorAssertions("reload_cleanup", observed(invalid))
      .some((item) => item.passed === false));
  }
  for (const [output, code] of [["shutdown error", 0], ["UnhandledPromiseRejection", 0], ["", 1]]) {
    assert.equal(behaviorAssertions("reload_cleanup", observed(undefined, output, code))[2].passed, false);
  }
});

test("reload assertions fail when the second Pi process omits responses seen in the initial process", () => {
  const makeRun = (name, responses) => {
    const assertions = behaviorAssertions(name, observed(responses));
    return {
      name,
      exit_code: 0,
      passed: assertions.every((item) => item.passed),
      evidence: JSON.stringify(responses),
      assertions,
      hasUnhandledError: false,
      hasLoadError: false,
    };
  };
  const initialProcess = makeRun("extension_load", [commandList]);
  assert.equal(initialProcess.passed, true);

  for (const secondResponses of [[], [prompt, notification], [commandList]]) {
    const secondProcess = makeRun("reload_cleanup", secondResponses);
    const result = combineReloadCleanup(initialProcess, secondProcess);
    assert.equal(result.passed, false);
    assert.ok(result.assertions.some((item) => item.passed === false));
    assert.match(result.evidence, /Second Pi process \(source of reload assertions\)/);
  }
});

test("malformed RPC must return a handled parser error; omitted/positive responses fail", () => {
  assert.equal(behaviorAssertions("error_path", observed([malformedRpc]))[0].passed, true);
  for (const invalid of [
    [],
    [{ ...malformedRpc, success: true }],
    [{ ...malformedRpc, error: "" }],
  ]) {
    assert.equal(behaviorAssertions("error_path", observed(invalid))[0].passed, false);
  }
});

test("host shell must return exact installed Pi SDK version, not merely exit zero", () => {
  assert.equal(behaviorAssertions("host_shell", observed([], "1.2.0\r\n"))[0].passed, true);
  for (const [output, code] of [["", 0], ["1.2.0 extra", 0], ["1.1.0", 0], ["1.2.0", 1]]) {
    assert.equal(behaviorAssertions("host_shell", observed([], output, code))[0].passed, false);
  }
});
