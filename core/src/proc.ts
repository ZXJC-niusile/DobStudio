/**
 * Child-process helpers.
 *
 * Everything the engine does to media is delegated to an external binary, so
 * spawning is the one primitive that has to be solid: line-buffered output,
 * cancellable, with a deadline.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the deadline fired and the process was killed. */
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard wall-clock limit in milliseconds. Default 10 minutes. */
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Spawn a process, invoking a callback per output line, and collect it all. */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const {
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onStdoutLine,
    onStderrLine,
    signal,
  } = options;

  return new Promise<RunResult>((resolve, reject) => {
    // An already-aborted signal never fires its listener, so check up front.
    // Without this, a cancelled job still spawns its child process.
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args], {
        cwd,
        env: env ?? process.env,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const outBuffer = { partial: "" };
    const errBuffer = { partial: "" };
    let timedOut = false;
    let settled = false;

    const terminate = (): void => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => { child.kill("SIGKILL"); });
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    const onAbort = (): void => {
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code: child.exitCode ?? -1,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
        timedOut,
      });
    };

    /** Accumulate a chunk, emit complete lines, keep the remainder buffered. */
    const feed = (
      chunk: Buffer,
      buffer: { partial: string },
      sink: string[],
      emit: ((line: string) => void) | undefined,
    ): void => {
      buffer.partial += chunk.toString("utf8");
      const parts = buffer.partial.split("\n");
      buffer.partial = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.replace(/\r$/, "");
        sink.push(line);
        emit?.(line);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      feed(chunk, outBuffer, stdoutLines, onStdoutLine);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      feed(chunk, errBuffer, stderrLines, onStderrLine);
    });

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code: number | null) => {
      // Flush any trailing partial line.
      if (outBuffer.partial !== "") {
        stdoutLines.push(outBuffer.partial);
        onStdoutLine?.(outBuffer.partial);
      }
      if (errBuffer.partial !== "") {
        stderrLines.push(errBuffer.partial);
        onStderrLine?.(errBuffer.partial);
      }
      finish();
    });
  });
}

/** True when `command` resolves and exits 0 for `--version`-style probes. */
export async function commandExists(
  command: string,
  args: readonly string[] = ["--version"],
): Promise<string | undefined> {
  try {
    const result = await run(command, args, { timeoutMs: 15_000 });
    if (result.code !== 0) return undefined;
    const firstLine =
      result.stdout.split("\n").find((l) => l.trim() !== "") ??
      result.stderr.split("\n").find((l) => l.trim() !== "");
    return firstLine?.trim();
  } catch {
    return undefined;
  }
}

/**
 * How a sidecar binary is launched.
 *
 * Normally this is `{ command: <path>, prefixArgs: [] }`, but separating the two
 * is what lets a test substitute a script for a real executable: a stub can
 * return `{ command: process.execPath, prefixArgs: [mockScript], env: {...} }`
 * and every call site keeps working unchanged.
 */
export interface Launcher {
  command: string;
  /** Arguments inserted before the caller's own. */
  prefixArgs: readonly string[];
  /** Environment overrides merged over `RunOptions.env`. */
  env?: NodeJS.ProcessEnv;
}
