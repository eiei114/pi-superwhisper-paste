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

type SessionHandle = {
  generation: number;
  ctx: PiRuntimeContext;
};

type BridgeState = {
  mode: BridgeMode;
  interval?: NodeJS.Timeout;
  generation: number;
  session?: SessionHandle;
  inFlightGeneration?: number;
  activatingGeneration?: number;
  terminalFocused: boolean;
  unsubscribeTerminalInput?: () => void;
  lastClipboard?: string;
  lastPasted?: string;
  lastPasteSummary?: string;
};

const state: BridgeState = {
  mode: defaultMode(),
  generation: 0,
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

function isCurrentSession(ctx: PiRuntimeContext, generation: number): boolean {
  return state.session?.generation === generation && state.session.ctx === ctx;
}

function safeWithCurrentUi(
  ctx: PiRuntimeContext,
  generation: number,
  action: (ui: PiEditorUi) => void,
): boolean {
  if (!isCurrentSession(ctx, generation)) return false;

  try {
    const ui = ctx.ui;
    if (!isCurrentSession(ctx, generation)) return false;
    action(ui);
    return true;
  } catch {
    // A Pi ctx can become stale between any callback/await boundary. Treat UI
    // failures as a closed session so the extension never bubbles the runner's
    // stale-ctx guard up as an uncaughtException.
    return false;
  }
}

function setStatus(ctx: PiRuntimeContext, generation: number): boolean {
  return safeWithCurrentUi(ctx, generation, (ui) => {
    ui.setStatus(STATUS_KEY, statusText());
  });
}

function notify(
  ctx: PiRuntimeContext,
  generation: number,
  message: string,
  level?: "info" | "warning" | "error" | "success",
): boolean {
  return safeWithCurrentUi(ctx, generation, (ui) => {
    ui.notify(message, level);
  });
}

function pasteToEditor(ctx: PiRuntimeContext, generation: number, text: string): boolean {
  return safeWithCurrentUi(ctx, generation, (ui) => {
    ui.pasteToEditor(text);
  });
}

function getEditorText(ctx: PiRuntimeContext, generation: number): string | undefined {
  if (!isCurrentSession(ctx, generation)) return undefined;

  try {
    const ui = ctx.ui;
    if (!isCurrentSession(ctx, generation)) return undefined;
    return String(ui.getEditorText?.() ?? "");
  } catch {
    return undefined;
  }
}

function markPasted(ctx: PiRuntimeContext, generation: number, text: string): void {
  if (!isCurrentSession(ctx, generation)) return;
  state.lastPasted = text;
  state.lastPasteSummary = `${text.length} chars`;
  // pasteToEditor mutates the editor directly; setStatus nudges Pi to redraw.
  setStatus(ctx, generation);
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

async function refreshClipboardBaseline(
  ctx: PiRuntimeContext,
  generation: number,
): Promise<void> {
  const text = await readClipboardText();
  if (!isCurrentSession(ctx, generation)) return;
  if (text !== undefined) state.lastClipboard = text;
}

async function activateTab(ctx: PiRuntimeContext, generation: number): Promise<void> {
  if (!isCurrentSession(ctx, generation) || state.activatingGeneration !== undefined) return;

  state.activatingGeneration = generation;
  try {
    if (!isCurrentSession(ctx, generation)) return;
    state.terminalFocused = true;
    await refreshClipboardBaseline(ctx, generation);
    if (!isCurrentSession(ctx, generation)) return;
    await claimActiveTab();
    if (!isCurrentSession(ctx, generation)) return;
    setStatus(ctx, generation);
  } finally {
    if (state.activatingGeneration === generation) state.activatingGeneration = undefined;
  }
}

async function markActiveFromInput(ctx: PiRuntimeContext, generation: number): Promise<void> {
  if (!isCurrentSession(ctx, generation)) return;
  state.terminalFocused = true;
  await claimActiveTab();
  if (!isCurrentSession(ctx, generation)) return;
  setStatus(ctx, generation);
}

function shouldPaste(text: string, ctx: PiRuntimeContext, generation: number): boolean {
  if (!text.trim()) return false;
  if (text.length > maxChars()) return false;
  if (text === state.lastPasted) return false;

  const current = getEditorText(ctx, generation);
  if (current === undefined) return false;
  if (current.endsWith(text)) return false;

  return true;
}

async function pasteClipboardChange(ctx: PiRuntimeContext, generation: number): Promise<void> {
  if (!isCurrentSession(ctx, generation)) return;
  if (
    state.inFlightGeneration !== undefined ||
    state.activatingGeneration === generation ||
    state.mode === "off"
  ) {
    return;
  }
  if (!ctx.hasUI) return;
  if (!(await isActiveTab())) return;
  if (!isCurrentSession(ctx, generation)) return;

  state.inFlightGeneration = generation;
  try {
    const text = await readClipboardText();
    if (!isCurrentSession(ctx, generation)) return;
    if (text === undefined || text === state.lastClipboard) return;

    state.lastClipboard = text;
    if (!shouldPaste(text, ctx, generation)) return;
    if (!(await isActiveTab())) return;
    if (!isCurrentSession(ctx, generation)) return;

    if (!pasteToEditor(ctx, generation, text)) return;
    markPasted(ctx, generation, text);
  } catch {
    // Clipboard polling should stay quiet while the user is typing.
  } finally {
    if (state.inFlightGeneration === generation) state.inFlightGeneration = undefined;
  }
}

function setupTerminalFocusTracking(ctx: PiRuntimeContext, generation: number): void {
  if (!isCurrentSession(ctx, generation)) return;
  if (state.unsubscribeTerminalInput) return;

  try {
    process.stdout.write(ENABLE_FOCUS_REPORTING);
  } catch {
    // Best-effort terminal focus setup only.
  }
  void activateTab(ctx, generation);

  safeWithCurrentUi(ctx, generation, (ui) => {
    state.unsubscribeTerminalInput = ui.onTerminalInput((data) => {
      if (!isCurrentSession(ctx, generation)) return undefined;

      if (data === FOCUS_IN) {
        void activateTab(ctx, generation);
        return { consume: true };
      }

      if (data === FOCUS_OUT) {
        state.terminalFocused = false;
        setStatus(ctx, generation);
        return { consume: true };
      }

      if (data.length > 0) {
        void markActiveFromInput(ctx, generation);
      }

      return undefined;
    });
  });
}

function teardownTerminalFocusTracking(): void {
  try {
    state.unsubscribeTerminalInput?.();
  } catch {
    // The old subscription may already belong to an invalidated session.
  }
  state.unsubscribeTerminalInput = undefined;

  try {
    process.stdout.write(DISABLE_FOCUS_REPORTING);
  } catch {
    // Best-effort terminal focus cleanup only.
  }
}

function teardownSessionResources(): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
  teardownTerminalFocusTracking();
  state.inFlightGeneration = undefined;
  state.activatingGeneration = undefined;
}

function beginSession(ctx: PiRuntimeContext): number {
  teardownSessionResources();
  const generation = state.generation + 1;
  state.generation = generation;
  state.session = { generation, ctx };
  return generation;
}

function ensureCurrentSession(ctx: PiRuntimeContext): number {
  if (state.session?.ctx === ctx) return state.session.generation;
  return beginSession(ctx);
}

function endSession(): void {
  teardownSessionResources();
  state.generation += 1;
  state.session = undefined;
}

function ensurePolling(ctx: PiRuntimeContext, generation: number): void {
  if (!isCurrentSession(ctx, generation)) return;

  setupTerminalFocusTracking(ctx, generation);
  setStatus(ctx, generation);

  if (state.interval) return;
  state.interval = setInterval(() => {
    if (isCurrentSession(ctx, generation)) void pasteClipboardChange(ctx, generation);
  }, intervalMs());
}

function stopPolling(ctx: PiRuntimeContext, generation: number): void {
  teardownSessionResources();
  state.mode = "off";
  setStatus(ctx, generation);
}

async function startPolling(ctx: PiRuntimeContext, generation: number): Promise<void> {
  const text = await readClipboardText();
  if (!isCurrentSession(ctx, generation)) return;
  state.lastClipboard = text;
  ensurePolling(ctx, generation);
}

async function arm(ctx: PiRuntimeContext, generation: number): Promise<void> {
  const text = await readClipboardText();
  if (!isCurrentSession(ctx, generation)) return;
  state.lastClipboard = text;
  state.mode = "on";
  ensurePolling(ctx, generation);
  notify(ctx, generation, "Superwhisper paste bridge: enabled", "info");
}

function parseControlCommand(text: string): BridgeMode | undefined {
  const match = text.trim().match(/^\/sw-paste:(on|off)$/i);
  if (!match) return undefined;
  return match[1].toLowerCase() as BridgeMode;
}

async function runControlAction(
  action: BridgeMode,
  ctx: PiRuntimeContext,
  generation: number,
): Promise<void> {
  if (action === "on") {
    await arm(ctx, generation);
    return;
  }

  stopPolling(ctx, generation);
  notify(ctx, generation, "Superwhisper paste bridge: disabled", "info");
}

export default function superwhisperPaste(pi: ExtensionAPI) {
  pi.registerCommand("sw-paste:on", {
    description: "Enable the Superwhisper clipboard paste bridge",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const generation = ensureCurrentSession(runtimeCtx);
      await runControlAction("on", runtimeCtx, generation);
    },
  });

  pi.registerCommand("sw-paste:off", {
    description: "Disable the Superwhisper clipboard paste bridge",
    handler: async (_args, ctx) => {
      const runtimeCtx = ctx as PiRuntimeContext;
      const generation = ensureCurrentSession(runtimeCtx);
      await runControlAction("off", runtimeCtx, generation);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const runtimeCtx = ctx as PiRuntimeContext;
    const generation = beginSession(runtimeCtx);
    if (state.mode !== "off") await startPolling(runtimeCtx, generation);
  });

  pi.on("session_shutdown", () => {
    endSession();
  });

  pi.on("input", async (event, ctx) => {
    const action = parseControlCommand(event.text);
    if (!action) return { action: "continue" };

    const runtimeCtx = ctx as PiRuntimeContext;
    const generation = ensureCurrentSession(runtimeCtx);
    await runControlAction(action, runtimeCtx, generation);
    return { action: "handled" };
  });
}
