export const VERIFICATION_CONTRACT = "pi-sdk-behavior-v2";
export const SDK_VERSIONS = Object.freeze({
  "@earendil-works/pi-agent-core": "1.1.0",
  "@earendil-works/pi-ai": "1.1.0",
  "@earendil-works/pi-coding-agent": "1.1.0",
  "@earendil-works/pi-tui": "1.1.0",
});
export const SDK_NAMES = Object.keys(SDK_VERSIONS);
export const UNHANDLED_ERROR_PATTERN = /UnhandledPromiseRejection|uncaught exception|shutdown error/i;
export const EXTENSION_LOAD_ERROR_PATTERN = /Failed to load extension|Error loading extension/i;

export function parseJsonLines(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function assertion(id, expected, observed, passed) {
  return { id, expected, observed: JSON.stringify(observed), passed: passed === true };
}

export function behaviorAssertions(name, { responses, fullOutput, exit_code, expectedSdkVersion }) {
  const commandList = responses.find((row) => row?.type === "response" && row.command === "get_commands");
  const commandNames = commandList?.data?.commands?.map((command) => command.name) ?? [];
  const registered = commandList?.success === true
    && commandNames.includes("sw-paste:on") && commandNames.includes("sw-paste:off");
  const prompt = responses.find((row) => row?.type === "response" && row.command === "prompt");
  const notification = responses.find((row) => row?.type === "extension_ui_request"
    && row.method === "notify" && row.message === "Superwhisper paste bridge: disabled");
  const handled = prompt?.success === true && prompt.data?.disposition === "handled" && !!notification;

  if (name === "extension_load") {
    return [assertion("extension_registered", "Real Pi get_commands lists both Superwhisper extension commands",
      commandList ?? null, registered)];
  }
  if (name === "happy_path") {
    return [assertion("feature_response", "Real Pi handles /sw-paste:off and emits its disabled notification",
      { prompt: prompt ?? null, notification: notification ?? null }, handled)];
  }
  if (name === "error_path") {
    const parse = responses.find((row) => row?.type === "response" && row.command === "parse");
    return [assertion("handled_error", "Malformed RPC input returns success=false with an observed parse error",
      parse ?? null, parse?.success === false && typeof parse.error === "string" && parse.error.length > 0)];
  }
  if (name === "reload_cleanup") {
    return [
      assertion("reloaded_extension_registered", "A fresh second Pi process lists both Superwhisper extension commands",
        commandList ?? null, registered),
      assertion("reloaded_feature_response", "The second process handles /sw-paste:off and emits the feature notification",
        { prompt: prompt ?? null, notification: notification ?? null }, handled),
      assertion("clean_shutdown", "The actual second Pi process exits zero without unhandled or shutdown errors",
        { exit_code, errors: UNHANDLED_ERROR_PATTERN.test(fullOutput) },
        exit_code === 0 && !UNHANDLED_ERROR_PATTERN.test(fullOutput)),
    ];
  }
  if (name === "host_shell") {
    return [assertion("native_shell_boundary", "The native host shell launches this checkout's Pi CLI and returns exactly 1.1.0",
      { exit_code, output: fullOutput.trim(), expectedSdkVersion },
      exit_code === 0 && fullOutput.trim() === expectedSdkVersion)];
  }
  throw new Error(`Unknown smoke case: ${name}`);
}
