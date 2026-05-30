import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STATUS_KEY = "superwhisper-paste";
const DEFAULT_INTERVAL_MS = 800;
const DEFAULT_MAX_CHARS = 8000;
const ACTIVE_STATE_FILE = "pi-superwhisper-paste-active.json";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type BridgeMode = "off" | "on";

type PiEditorUi = {
  setStatus(key: string, value: string | undefined): void;
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  pasteToEditor(text: string): void;
  getEditorText?: () => string;
};

type PiRuntimeContext = {
  hasUI?: boolean;
  ui: PiEditorUi;
};

type BridgeState = {
  mode: BridgeMode;
  interval?: NodeJS.Timeout;
  inFlight: boolean;
  activating: boolean;
  terminalFocused: boolean;
  unsubscribeTerminalInput?: () => void;
  lastClipboard?: string;
  lastPasted?: string;
  lastPasteSummary?: string;
  ctx?: PiRuntimeContext;
};

const state: BridgeState = {
  mode: defaultMode(),
  inFlight: false,
  activating: false,
  terminalFocused: true,
};

function defaultMode(): BridgeMode {
  const raw = (process.env.PI_SUPERWHISPER_PASTE ?? "on").trim().toLowerCase();
  return ["0", "false", "no", "off"].includes(raw) ? "off" : "on";
}

function intervalMs(): number {
  const parsed = Number(process.env.PI_SUPERWHISPER_PASTE_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

function maxChars(): number {
  const parsed = Number(process.env.PI_SUPERWHISPER_PASTE_MAX_CHARS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CHARS;
}

function statusText(): string | undefined {
  if (state.mode === "off") return undefined;
  const focusText = state.terminalFocused ? "active" : "standby";
  return state.lastPasteSummary
    ? `SW paste: ${focusText} (${state.lastPasteSummary})`
    : `SW paste: ${focusText}`;
}

function setStatus(ctx: PiRuntimeContext): void {
  ctx.ui.setStatus(STATUS_KEY, statusText());
}

function markPasted(ctx: PiRuntimeContext, text: string): void {
  state.lastPasted = text;
  state.lastPasteSummary = `${text.length} chars`;
  // pasteToEditor mutates the editor directly; setStatus nudges Pi to redraw.
  setStatus(ctx);
}

async function readClipboardText(): Promise<string | undefined> {
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$text = Get-Clipboard -Raw -Format Text -ErrorAction SilentlyContinue",
    "if ($null -ne $text) { [Console]::Out.Write($text) }",
  ].join("; ");

  const result = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    {
      encoding: "utf8",
      maxBuffer: maxChars() * 4,
      timeout: 2500,
      windowsHide: true,
    },
  );

  return typeof result.stdout === "string" ? result.stdout : undefined;
}

function activeStatePath(): string {
  return join(tmpdir(), ACTIVE_STATE_FILE);
}

async function claimActiveTab(): Promise<void> {
  const claim = {
    instanceId: INSTANCE_ID,
    pid: process.pid,
    updatedAt: Date.now(),
  };

  try {
    await writeFile(activeStatePath(), JSON.stringify(claim), "utf8");
  } catch {
    // Focus tracking is best-effort; clipboard safety still falls back to local focus state.
  }
}

async function isActiveTab(): Promise<boolean> {
  if (!state.terminalFocused) return false;

  try {
    const raw = await readFile(activeStatePath(), "utf8");
    const claim = JSON.parse(raw) as { instanceId?: string };
    return claim.instanceId === INSTANCE_ID;
  } catch {
    await claimActiveTab();
    return true;
  }
}

async function refreshClipboardBaseline(): Promise<void> {
  const text = await readClipboardText();
  if (text !== undefined) state.lastClipboard = text;
}

async function activateTab(ctx: PiRuntimeContext): Promise<void> {
  if (state.activating) return;

  state.activating = true;
  try {
    state.terminalFocused = true;
    await refreshClipboardBaseline();
    await claimActiveTab();
    setStatus(ctx);
  } finally {
    state.activating = false;
  }
}

async function markActiveFromInput(ctx: PiRuntimeContext): Promise<void> {
  state.terminalFocused = true;
  await claimActiveTab();
  setStatus(ctx);
}

function shouldPaste(text: string, ctx: PiRuntimeContext): boolean {
  if (!text.trim()) return false;
  if (text.length > maxChars()) return false;
  if (text === state.lastPasted) return false;

  const current = String(ctx.ui.getEditorText?.() ?? "");
  if (current.endsWith(text)) return false;

  return true;
}

async function pasteClipboardChange(ctx: PiRuntimeContext): Promise<void> {
  if (state.inFlight || state.activating || state.mode === "off") return;
  if (!ctx.hasUI) return;
  if (!(await isActiveTab())) return;

  state.inFlight = true;
  try {
    const text = await readClipboardText();
    if (text === undefined || text === state.lastClipboard) return;

    state.lastClipboard = text;
    if (!shouldPaste(text, ctx)) return;
    if (!(await isActiveTab())) return;

    ctx.ui.pasteToEditor(text);
    markPasted(ctx, text);
  } catch {
    // Clipboard polling should stay quiet while the user is typing.
  } finally {
    state.inFlight = false;
  }
}

function setupTerminalFocusTracking(ctx: PiRuntimeContext): void {
  if (state.unsubscribeTerminalInput) return;

  process.stdout.write(ENABLE_FOCUS_REPORTING);
  void activateTab(ctx);

  state.unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
    if (data === FOCUS_IN) {
      void activateTab(ctx);
      return { consume: true };
    }

    if (data === FOCUS_OUT) {
      state.terminalFocused = false;
      setStatus(ctx);
      return { consume: true };
    }

    if (data.length > 0) {
      void markActiveFromInput(ctx);
    }

    return undefined;
  });
}

function teardownTerminalFocusTracking(): void {
  state.unsubscribeTerminalInput?.();
  state.unsubscribeTerminalInput = undefined;
  process.stdout.write(DISABLE_FOCUS_REPORTING);
}

function ensurePolling(ctx: PiRuntimeContext): void {
  state.ctx = ctx;
  setupTerminalFocusTracking(ctx);
  setStatus(ctx);

  if (state.interval) return;
  state.interval = setInterval(() => {
    if (state.ctx) void pasteClipboardChange(state.ctx);
  }, intervalMs());
}

function stopPolling(ctx?: PiRuntimeContext): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  teardownTerminalFocusTracking();
  state.mode = "off";
  if (ctx) setStatus(ctx);
}

async function startPolling(ctx: PiRuntimeContext): Promise<void> {
  state.lastClipboard = await readClipboardText();
  ensurePolling(ctx);
}

async function arm(ctx: PiRuntimeContext): Promise<void> {
  state.lastClipboard = await readClipboardText();
  state.mode = "on";
  ensurePolling(ctx);
  ctx.ui.notify("Superwhisper paste bridge: enabled", "info");
}

function parseControlCommand(text: string): BridgeMode | undefined {
  const match = text.trim().match(/^\/sw-paste:(on|off)$/i);
  if (!match) return undefined;
  return match[1].toLowerCase() as BridgeMode;
}

async function runControlAction(action: BridgeMode, ctx: PiRuntimeContext): Promise<void> {
  if (action === "on") {
    await arm(ctx);
    return;
  }

  stopPolling(ctx);
  ctx.ui.notify("Superwhisper paste bridge: disabled", "info");
}

export default function superwhisperPaste(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const runtimeCtx = ctx as PiRuntimeContext;
    state.ctx = runtimeCtx;
    if (state.mode !== "off") await startPolling(runtimeCtx);
  });

  pi.on("session_shutdown", () => {
    stopPolling();
  });

  pi.on("input", async (event, ctx) => {
    const action = parseControlCommand(event.text);
    if (!action) return { action: "continue" };

    await runControlAction(action, ctx as PiRuntimeContext);
    return { action: "handled" };
  });
}