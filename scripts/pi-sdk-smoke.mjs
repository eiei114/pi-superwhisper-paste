import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  behaviorAssertions,
  EXTENSION_LOAD_ERROR_PATTERN,
  parseJsonLines,
  SDK_NAMES,
  SDK_VERSIONS,
  UNHANDLED_ERROR_PATTERN,
  VERIFICATION_CONTRACT,
} from "./pi-sdk-smoke-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const reportPath = resolve(root, "docs/verification/pi-sdk-smoke.json");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = readJson(resolve(root, "package.json"));
const sdkVersions = Object.fromEntries(SDK_NAMES.map((name) =>
  [name, readJson(resolve(root, "node_modules", name, "package.json")).version]));

for (const name of SDK_NAMES) {
  if (manifest.devDependencies?.[name] !== SDK_VERSIONS[name] || sdkVersions[name] !== SDK_VERSIONS[name]) {
    throw new Error(`Smoke requires exact Pi SDK ${SDK_VERSIONS[name]} dev/test pin for ${name}; found ${sdkVersions[name]}`);
  }
}

const piManifest = readJson(resolve(root, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const piCli = resolve(root, "node_modules/@earendil-works/pi-coding-agent", piManifest.bin.pi);
const agentDir = mkdtempSync(resolve(tmpdir(), "pi-sdk-smoke-"));
const env = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_SUPERWHISPER_PASTE: "off",
  TMP: agentDir,
  TEMP: agentDir,
  TMPDIR: agentDir,
};
const rpcArgs = [piCli, "--offline", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
  "--no-context-files", "--no-prompt-templates", "--no-mcp", "-e", ".", "--mode", "rpc"];
const commandListInput = '{"type":"get_commands"}\n';
const featureInput = '{"type":"prompt","message":"/sw-paste:off"}\n';
const reloadInput = `${commandListInput}${featureInput}`;

function run(name, executable, args, input) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const fullOutput = `${stdout}${stderr}`;
  const exit_code = result.status ?? 1;
  const responses = [...parseJsonLines(stdout), ...parseJsonLines(stderr)];
  const assertions = behaviorAssertions(name, {
    responses,
    fullOutput,
    exit_code,
    expectedSdkVersion: SDK_VERSIONS["@earendil-works/pi-coding-agent"],
  });
  const hasUnhandledError = UNHANDLED_ERROR_PATTERN.test(fullOutput);
  const hasLoadError = EXTENSION_LOAD_ERROR_PATTERN.test(fullOutput);
  const passed = exit_code === 0 && !result.error && !hasUnhandledError && !hasLoadError
    && assertions.every((item) => item.passed);
  const evidence = fullOutput.slice(-6000) || String(result.error?.message ?? "No output captured");

  return { name, command: "npm run smoke:pi", exit_code, passed, evidence, assertions,
    hasUnhandledError, hasLoadError };
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

try {
  const cases = [
    run("extension_load", process.execPath, rpcArgs, commandListInput),
    run("happy_path", process.execPath, rpcArgs, featureInput),
    run("error_path", process.execPath, rpcArgs, "not-json\n"),
    run("reload_cleanup", process.execPath, rpcArgs, reloadInput),
  ];

  if (process.platform === "win32") {
    const shell = resolve(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    cases.push(run("host_shell", shell, ["-NoProfile", "-NonInteractive", "-Command",
      `& ${quotePowerShell(process.execPath)} ${quotePowerShell(piCli)} --no-extensions --version; exit $LASTEXITCODE`], ""));
  } else {
    cases.push(run("host_shell", "/bin/sh", ["-c", '"$1" "$2" --no-extensions --version',
      "pi-host-shell", process.execPath, piCli], ""));
  }

  const report = {
    schema_version: 1,
    verification_contract: VERIFICATION_CONTRACT,
    sdk_versions: sdkVersions,
    platform: process.platform,
    model_inference: "none; actual Pi host handles command discovery and deterministic /sw-paste:off input; clipboard access disabled",
    feature_boundary: "PI_SUPERWHISPER_PASTE=off avoids reading or changing the user's shared clipboard; the real Pi process still loads the extension and handles both commands. This smoke does not claim live clipboard insertion.",
    unhandled_errors: cases.filter((item) => item.hasUnhandledError).length,
    extension_load_errors: cases.filter((item) => item.hasLoadError
      || (item.name === "extension_load" && !item.passed)).length,
    cases: cases.map(({ hasUnhandledError, hasLoadError, ...item }) => item),
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ verification_contract: VERIFICATION_CONTRACT, platform: process.platform,
    cases: cases.map((item) => ({ name: item.name, passed: item.passed, exit_code: item.exit_code })) }));
  if (cases.some((item) => !item.passed)) process.exitCode = 1;
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
