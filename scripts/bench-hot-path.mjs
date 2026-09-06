/**
 * Micro-benchmark for clipboard poll hot-path helpers (uncached baseline).
 * Run before/after perf changes: node scripts/bench-hot-path.mjs
 */
const DEFAULT_OWNER_DENYLIST = [
  "windowsterminal",
  "windowsterminal.exe",
  "windows terminal",
  "openconsole",
  "openconsole.exe",
  "wezterm",
  "alacritty",
  "mintty",
  "conhost",
  "cmd.exe",
  "code",
  "code.exe",
  "powershell",
  "pwsh",
  "bash",
  "cursor",
  "cursor.exe",
  "wsl",
];

function clipboardPowerShellScript(limit) {
  return [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$signature = @\"",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class ClipboardOwnerNative {",
    "  [DllImport(\"user32.dll\")] public static extern IntPtr GetClipboardOwner();",
    "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
    "}",
    "\"@",
    "Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue",
    `$limit = ${limit}`,
    "$text = Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue",
    "$ownerProcessName = $null",
    "$ownerProcessPath = $null",
    "try {",
    "  $ownerWindow = [ClipboardOwnerNative]::GetClipboardOwner()",
    "  if ($ownerWindow -ne [IntPtr]::Zero) {",
    "    $ownerPid = 0",
    "    [void][ClipboardOwnerNative]::GetWindowThreadProcessId($ownerWindow, [ref]$ownerPid)",
    "    if ($ownerPid -gt 0) {",
    "      $ownerProcess = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue",
    "      if ($null -ne $ownerProcess) {",
    "        $ownerProcessName = $ownerProcess.ProcessName",
    "        $ownerProcessPath = $ownerProcess.Path",
    "      }",
    "    }",
    "  }",
    "} catch {}",
    "if ($null -ne $text) {",
    "  if ($text.Length -gt $limit) { $text = $text.Substring(0, $limit) }",
    "}",
    "$result = @{ text = $text; ownerProcessName = $ownerProcessName; ownerProcessPath = $ownerProcessPath }",
    "[Console]::Out.Write(($result | ConvertTo-Json -Compress))",
  ].join("\n");
}

function ownerDenylistUncached() {
  const raw = process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST;
  if (!raw) return DEFAULT_OWNER_DENYLIST;
  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : DEFAULT_OWNER_DENYLIST;
}

let cachedOwnerDenylistEnv;
let cachedOwnerDenylist;

function ownerDenylistCached() {
  const raw = process.env.PI_SUPERWHISPER_PASTE_OWNER_DENYLIST ?? "";
  if (cachedOwnerDenylist && cachedOwnerDenylistEnv === raw) return cachedOwnerDenylist;
  cachedOwnerDenylistEnv = raw;
  if (!raw) {
    cachedOwnerDenylist = DEFAULT_OWNER_DENYLIST;
    return cachedOwnerDenylist;
  }
  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  cachedOwnerDenylist = tokens.length > 0 ? tokens : DEFAULT_OWNER_DENYLIST;
  return cachedOwnerDenylist;
}

let cachedClipboardScript;

function clipboardPowerShellScriptCached(limit) {
  if (cachedClipboardScript?.limit === limit) return cachedClipboardScript.script;
  const script = clipboardPowerShellScript(limit);
  cachedClipboardScript = { limit, script };
  return script;
}

function bench(label, fn, iterations = 50_000) {
  fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn();
  return { label, iterations, elapsed_ms: Number((performance.now() - start).toFixed(2)) };
}

const results = [
  bench("clipboardPowerShellScript (uncached)", () => clipboardPowerShellScript(8000)),
  bench("clipboardPowerShellScript (cached)", () => clipboardPowerShellScriptCached(8000)),
  bench("ownerDenylist (uncached)", () => ownerDenylistUncached()),
  bench("ownerDenylist (cached)", () => ownerDenylistCached()),
];

console.log(JSON.stringify(results, null, 2));
