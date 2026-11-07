/**
 * Recording-file source for the Superwhisper bridge.
 *
 * ## Why this exists
 *
 * The clipboard source works because Superwhisper puts its transcription on the
 * clipboard and then tries to paste it. On Windows that paste goes through UI
 * Automation to find an editable target. Herdr's GPUI window (`Zed::Window`)
 * exposes an empty UIA tree — no children, no focused element — so Superwhisper
 * finds nothing to paste into and silently drops the transcription. Key
 * injection itself works fine; Superwhisper never gets that far.
 *
 * Superwhisper already writes every transcription to disk before it tries to
 * paste, so reading that file sidesteps the clipboard and UIA entirely.
 *
 * ## How it works
 *
 *   1. A recording finishes and Superwhisper writes
 *      `%LOCALAPPDATA%\com.superwhisper.app\recordings\<id>\meta.json`.
 *   2. We watch that folder and read `result` from new, recent recordings.
 *   3. The text is pasted into the editor, with no submit.
 *
 * Recording folder ids are timestamps, so anything at or below the id present
 * when the source starts is history. That keeps a scan cheap even with many
 * thousands of past recordings on disk.
 */

import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Transcription older than this is treated as history, not new speech. */
export const DEFAULT_FRESH_MS = 20_000;
/** Idle poll cadence; fs.watch normally reacts long before this. */
export const DEFAULT_POLL_MS = 2_500;
/** Cadence while a new recording folder exists but its meta.json has not. */
export const DEFAULT_HOT_POLL_MS = 25;

export type RecordingMeta = {
  result?: unknown;
  languageModelProcessingTime?: unknown;
  processingTime?: unknown;
  duration?: unknown;
};

/** Root of Superwhisper's recordings on this machine. */
export function defaultRecordingsDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "com.superwhisper.app", "recordings");
}

/** True when `dir` exists and is a directory. */
export function recordingsDirAvailable(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Highest numeric recording id in `dir`, or 0 when empty.
 *
 * Ids are millisecond timestamps and increase monotonically, so this is the
 * boundary between "already existed when we started" and "new speech".
 */
export function highWaterMark(dir: string): number {
  if (!existsSync(dir)) return 0;

  let max = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  for (const id of entries) {
    const n = Number(id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/**
 * Reads the transcription out of one recording's meta.json.
 *
 * A half-written file is normal: Superwhisper writes it in place, so a parse
 * failure means "not ready yet", not "no speech".
 */
export function readRecordingResult(
  dir: string,
  id: string,
  maxChars: number,
): { text: string } | { text?: undefined; pending: boolean } {
  const metaPath = join(dir, id, "meta.json");

  let raw: string;
  try {
    raw = readFileSync(metaPath, "utf8");
  } catch {
    return { pending: true };
  }

  let meta: RecordingMeta;
  try {
    meta = JSON.parse(raw) as RecordingMeta;
  } catch {
    return { pending: true };
  }

  const result = typeof meta.result === "string" ? meta.result.trim() : "";
  if (result.length === 0) return { pending: true };
  if (result.length > maxChars) return { text: result.slice(0, maxChars) };
  return { text: result };
}

/** Modification time of one recording's meta.json, or undefined when absent. */
export function recordingMtime(dir: string, id: string): number | undefined {
  try {
    return statSync(join(dir, id, "meta.json")).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Age of a recording folder, falling back to the folder's own mtime when its
 * meta.json has not been written yet.
 */
export function recordingAge(dir: string, id: string): number | undefined {
  const metaMtime = recordingMtime(dir, id);
  if (metaMtime !== undefined) return Date.now() - metaMtime;

  try {
    return Date.now() - statSync(join(dir, id)).mtimeMs;
  } catch {
    return undefined;
  }
}

export type RecordingSourceOptions = {
  /** Folder holding the `<id>/meta.json` recording folders. */
  dir?: string;
  /** Max characters accepted from one transcription. */
  maxChars: () => number;
  /** Receives transcriptions that pass every gate. */
  onText: (text: string) => void;
  /** Diagnostic sink; must never write to stdout/stderr under a live TUI. */
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  freshMs?: number;
  pollMs?: number;
  hotPollMs?: number;
};

export type RecordingSource = {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** Test seam: run one poll pass synchronously. */
  poll(): void;
  /** Test seam: treat a folder name as newly reported by fs.watch. */
  consider(id: string | null | undefined): void;
};

/**
 * Watches Superwhisper's recordings folder and forwards new transcriptions.
 *
 * Callers get one `onText` per recording. Re-reading the same folder, or
 * noticing it before its meta.json lands, never produces a duplicate.
 */
export function createRecordingSource(options: RecordingSourceOptions): RecordingSource {
  const dir = options.dir ?? defaultRecordingsDir();
  const freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const hotPollMs = options.hotPollMs ?? DEFAULT_HOT_POLL_MS;
  const log = options.log ?? (() => {});

  /** Recording ids already handled, so each transcription is delivered once. */
  const seen = new Set<string>();
  /** Ids whose meta.json is missing or incomplete; retried on the hot cadence. */
  const pending = new Set<string>();

  let running = false;
  let highWater = 0;
  let watcher: ReturnType<typeof watch> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let currentPollMs = 0;
  /** Guards against re-entrant delivery while a poll pass is in flight. */
  let delivering = false;

  function startPoller(ms: number): void {
    if (poller) clearInterval(poller);
    currentPollMs = ms;
    poller = setInterval(poll, ms);
  }

  function deliver(text: string): void {
    if (delivering) return;
    delivering = true;
    try {
      options.onText(text);
    } catch (error) {
      log("error", `onText failed: ${error}`);
    } finally {
      delivering = false;
    }
  }

  function tryDeliver(id: string): void {
    const maxChars = options.maxChars();
    const read = readRecordingResult(dir, id, maxChars);

    if (read.text === undefined) {
      // Not ready yet. A missing meta.json is normal for a folder fs.watch just
      // announced, so fall back to the folder's own mtime and only give up once
      // the recording itself has gone stale.
      const age = recordingAge(dir, id);
      if (age !== undefined && age > freshMs) {
        pending.delete(id);
        seen.add(id);
        log("debug", `give up on recording ${id} (no result)`);
      } else {
        pending.add(id);
      }
      return;
    }

    pending.delete(id);
    seen.add(id);

    const mtime = recordingMtime(dir, id);
    if (mtime !== undefined && Date.now() - mtime > freshMs) {
      log("debug", `skip stale recording ${id}`);
      return;
    }

    log("info", `recording ${id}: ${JSON.stringify(read.text.slice(0, 60))}`);
    deliver(read.text);
  }

  /**
   * Finds recording folders that fs.watch did not report.
   *
   * fs.watch can be unavailable, can fail later, or can drop events, so the
   * idle poll also lists the folder. Only ids above the start-time high-water
   * mark are considered, so history stays cheap to skip.
   */
  function scanForNew(): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const id of entries) {
      if (!running) return;
      if (seen.has(id) || pending.has(id)) continue;
      const n = Number(id);
      if (Number.isFinite(n) && n > highWater) consider(id);
    }
  }

  function poll(): void {
    if (!running) return;

    for (const id of [...pending]) tryDeliver(id);
    // The hot cadence only retries known folders; listing runs on the idle tick.
    if (currentPollMs !== hotPollMs) scanForNew();

    // Nothing outstanding: fall back to the idle cadence and let fs.watch
    // wake us when the next recording appears.
    if (pending.size === 0 && currentPollMs !== pollMs) startPoller(pollMs);
  }

  function consider(id: string | null | undefined): void {
    if (!running || !id) return;
    if (seen.has(id)) return;

    const n = Number(id);
    if (!Number.isFinite(n) || n <= highWater) return;

    // A live event: check now rather than waiting for the idle tick.
    if (currentPollMs !== hotPollMs) startPoller(hotPollMs);
    tryDeliver(id);
  }

  function start(): void {
    if (running) return;

    if (!recordingsDirAvailable(dir)) {
      log("warn", `recordings folder unavailable: ${dir}`);
      return;
    }

    seen.clear();
    pending.clear();
    // Everything already on disk is history; only newer ids can be new speech.
    highWater = highWaterMark(dir);
    running = true;

    try {
      const active = watch(dir, { persistent: false }, (_event, filename) =>
        consider(filename?.toString()),
      );
      // An FSWatcher without an 'error' listener throws, which would take the
      // whole Pi process down (for example when the folder is removed).
      active.on("error", (error) => {
        log("warn", `fs.watch failed, polling only: ${error}`);
        try {
          active.close();
        } catch {
          // Already closed.
        }
        if (watcher === active) watcher = undefined;
      });
      watcher = active;
    } catch (error) {
      // Polling alone still works, just slower to notice a new folder.
      log("warn", `fs.watch unavailable: ${error}`);
    }

    startPoller(pollMs);
    log("info", `watching ${dir} (highWater=${highWater})`);
  }

  function stop(): void {
    running = false;

    try {
      watcher?.close();
    } catch {
      // Closing an already-closed watcher is not an error worth surfacing.
    }
    watcher = undefined;

    if (poller) clearInterval(poller);
    poller = undefined;
    currentPollMs = 0;

    pending.clear();
    log("info", "stopped");
  }

  return {
    start,
    stop,
    isRunning: () => running,
    poll,
    consider,
  };
}
