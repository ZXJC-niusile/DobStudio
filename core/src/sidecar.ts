/**
 * Sidecar binary management.
 *
 * The engine never links against yt-dlp, ffmpeg or whisper.cpp. It downloads
 * pinned builds into a per-user directory on first use and shells out to them.
 * That keeps the app itself free of native build steps and makes a stack
 * swap (Electron ↔ CLI) a UI-only change.
 *
 * IMPORTANT — scope note. The download layer exposes no authentication path:
 * no `--cookies`, no `--cookies-from-browser`, no `--username/--password`, no
 * header injection. It downloads what the source serves to an anonymous
 * client. Anything that needs a signed-in session is deliberately out of
 * scope for this project.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { run, type Launcher, type RunOptions, type RunResult } from "./proc.ts";
import { WHISPER_MODELS } from "./catalog.ts";
import type {
  BinaryName,
  BinaryStatus,
  SidecarProgress,
  WhisperModel,
} from "./types.ts";

export interface BinarySpec {
  /** Direct download URL for the executable or archive. */
  url: string;
  /** Archive format, when the URL is not the executable itself. */
  archive?: "zip";
  /** Glob for one entry inside the archive. */
  entry?: string;
  /**
   * Extract every file under this directory prefix.
   *
   * Needed when the executable is not self-contained: whisper.cpp's
   * `whisper-cli.exe` is 480 KB and loads `ggml*.dll`, `whisper.dll` and
   * `SDL2.dll` from beside it, so pulling out just the exe produces a binary
   * that fails to start with no diagnostic at all.
   */
  entryDir?: string;
  /** Lowercase hex SHA-256 of the download, when known. */
  sha256?: string;
  /** Executable filename once unpacked. */
  fileName: string;
}

function platform(): "win32" | "darwin" | "linux" {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

const EXE = platform() === "win32" ? ".exe" : "";

/** Pinned upstream sources. Bump these deliberately, with a release note. */
export const BINARY_SPECS: Record<BinaryName, BinarySpec> = {
  "yt-dlp": {
    url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" + EXE,
    fileName: `yt-dlp${EXE}`,
  },
  ffmpeg: {
    url:
      platform() === "win32"
        ? "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
        : platform() === "darwin"
          ? "https://evermeet.cx/ffmpeg/getrelease/zip"
          : "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
    archive: "zip",
    entry: "*/bin/ffmpeg" + EXE,
    fileName: `ffmpeg${EXE}`,
  },
  ffprobe: {
    url:
      platform() === "win32"
        ? "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
        : platform() === "darwin"
          ? "https://evermeet.cx/ffmpeg/getrelease/zip"
          : "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
    archive: "zip",
    entry: "*/bin/ffprobe" + EXE,
    fileName: `ffprobe${EXE}`,
  },
  whisper: {
    url:
      platform() === "win32"
        ? "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip"
        : platform() === "darwin"
          ? "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-arm64.zip"
          : "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip",
    archive: "zip",
    entryDir: "Release/",
    fileName: `whisper-cli${EXE}`,
  },
};

const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const HF_MIRROR = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main";

export interface SidecarOptions {
  /** Directory that holds executables and model weights. */
  binDir: string;
  /** Use the hf-mirror.com mirror for model downloads. */
  useMirror?: boolean;
  onProgress?: (progress: SidecarProgress) => void;
  signal?: AbortSignal;
}

export class Sidecar {
  readonly binDir: string;

  constructor(options: SidecarOptions) {
    this.binDir = options.binDir;
    this.options = options;
  }

  private readonly options: SidecarOptions;

  /** Absolute path a binary would occupy, present or not. */
  pathFor(name: BinaryName): string {
    return join(this.binDir, "bin", BINARY_SPECS[name].fileName);
  }

  /** Absolute path a model would occupy, present or not. */
  modelPathFor(model: WhisperModel): string {
    return join(this.binDir, "models", WHISPER_MODELS[model].fileName);
  }

  /**
   * How to launch a binary.
   *
   * Overridable so a test can substitute a script for the real executable
   * without touching any call site.
   */
  async launcherFor(name: BinaryName): Promise<Launcher> {
    const path = await this.ensureBinary(name);
    return { command: path, prefixArgs: [] };
  }

  /** Download (if needed) and run a sidecar binary. */
  async run(
    name: BinaryName,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    const { command, prefixArgs, env } = await this.launcherFor(name);
    return run(command, [...prefixArgs, ...args], {
      ...options,
      env: env === undefined ? options.env : { ...options.env, ...env },
    });
  }

  async status(): Promise<BinaryStatus[]> {
    const names: BinaryName[] = ["yt-dlp", "ffmpeg", "ffprobe", "whisper"];
    const out: BinaryStatus[] = [];
    for (const name of names) {
      const path = this.pathFor(name);
      const present = existsSync(path);
      let version: string | undefined;
      if (present) {
        const probe = await run(path, ["--version"], { timeoutMs: 20_000 });
        version =
          probe.stdout.split("\n")[0]?.trim() ||
          probe.stderr.split("\n")[0]?.trim();
      }
      out.push({ name, present, path: present ? path : undefined, version });
    }
    return out;
  }

  /** Download (if needed) and return the executable path. */
  async ensureBinary(name: BinaryName): Promise<string> {
    const target = this.pathFor(name);
    if (existsSync(target)) return target;

    const spec = BINARY_SPECS[name];
    await mkdir(join(this.binDir, "bin"), { recursive: true });

    const tmpFile = join(this.binDir, "bin", `.dl-${name}-${Date.now()}`);
    // A 100 MB archive must not survive a failed install, so the temp file is
    // removed on every path out of here.
    try {
      await this.downloadTo(spec.url, tmpFile, name);

      if (spec.sha256) {
        const actual = await sha256File(tmpFile);
        if (actual !== spec.sha256) {
          throw new Error(
            `${name}: checksum mismatch (got ${actual}, want ${spec.sha256})`,
          );
        }
      }

      if (spec.archive === "zip") {
        await this.extractFromZip(tmpFile, spec, join(this.binDir, "bin"));
      } else {
        await rename(tmpFile, target);
      }
    } finally {
      await rm(tmpFile, { force: true });
    }

    if (platform() !== "win32") {
      chmodSync(target, 0o755);
    }
    return target;
  }

  /** Download (if needed) and return the GGML model path. */
  async ensureModel(model: WhisperModel): Promise<string> {
    const target = this.modelPathFor(model);
    if (existsSync(target)) return target;

    await mkdir(join(this.binDir, "models"), { recursive: true });
    const base = this.options.useMirror ? HF_MIRROR : HF_BASE;
    const url = `${base}/${WHISPER_MODELS[model].fileName}`;

    const tmpFile = `${target}.part`;
    try {
      await this.downloadTo(url, tmpFile, "whisper");
      await rename(tmpFile, target);
    } catch (error) {
      await rm(tmpFile, { force: true });
      throw error;
    }
    return target;
  }

  /** Fetch a URL to disk, reporting byte progress. */
  private async downloadTo(
    url: string,
    destination: string,
    name: BinaryName,
  ): Promise<void> {
    const response = await fetch(url, {
      signal: this.options.signal,
      redirect: "follow",
      headers: { "User-Agent": "dobstudio/0.1" },
    });
    if (!response.ok || !response.body) {
      throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    }

    const totalHeader = response.headers.get("content-length");
    const totalBytes = totalHeader ? Number(totalHeader) : undefined;

    let receivedBytes = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        receivedBytes += chunk.byteLength;
        this.options.onProgress?.({ name, receivedBytes, totalBytes });
        controller.enqueue(chunk);
      },
    });

    await pipeline(
      response.body.pipeThrough(counter) as unknown as NodeJS.ReadableStream,
      createWriteStream(destination),
    );
  }

  /**
   * Pull one entry out of a zip archive.
   *
   * Windows 10 1803+ ships bsdtar as `tar.exe`, which reads zip natively, so
   * there is no dependency on a JS unzip library.
   *
   * The binary is resolved by absolute path rather than by name: a bare `tar`
   * picks up whatever appears first on PATH, and on a machine with Git Bash,
   * MSYS or Cygwin installed that is GNU tar — which cannot read zip at all.
   * PowerShell's `Expand-Archive` is the fallback for a box without bsdtar.
   */
  private async extractFromZip(
    archivePath: string,
    spec: BinarySpec,
    destinationDir: string,
  ): Promise<void> {
    const staging = join(this.binDir, ".extract", String(process.pid));
    mkdirSync(staging, { recursive: true });

    try {
      const tar = resolveTar();
      const list = await run(tar, ["-tf", archivePath], { timeoutMs: 60_000 });
      if (list.code !== 0) {
        throw new Error(
          `could not list ${archivePath} with ${tar}: ${list.stderr.slice(0, 200)}`,
        );
      }

      const candidates = list.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      let selected: string[];
      if (spec.entryDir !== undefined) {
        // Everything under the prefix, flattened into the destination.
        selected = candidates.filter((entry) => entry.startsWith(spec.entryDir!));
        if (selected.length === 0) {
          throw new Error(
            `archive did not contain ${spec.entryDir}; saw ${candidates.slice(0, 5).join(", ")}`,
          );
        }
      } else {
        const matcher = globToRegExp(spec.entry ?? spec.fileName);
        const match = candidates.find((candidate) => matcher.test(candidate));
        if (!match) {
          throw new Error(
            `archive did not contain ${spec.entry ?? spec.fileName}; saw ${candidates.slice(0, 5).join(", ")}`,
          );
        }
        selected = [match];
      }

      const extract = await run(
        tar,
        ["-xf", archivePath, "-C", staging, ...selected],
        { timeoutMs: 180_000 },
      );
      if (extract.code !== 0) {
        throw new Error(`tar extract failed: ${extract.stderr.slice(0, 400)}`);
      }

      mkdirSync(destinationDir, { recursive: true });
      for (const entry of selected) {
        if (entry.endsWith("/")) continue; // directory marker
        const from = join(staging, entry);
        if (!existsSync(from)) {
          throw new Error(`extracted file missing at ${from}`);
        }
        const to = join(destinationDir, basename(entry));
        await rename(from, to);
        if (platform() !== "win32") chmodSync(to, 0o755);
      }

      const primary = join(destinationDir, spec.fileName);
      if (!existsSync(primary)) {
        throw new Error(
          `${spec.fileName} was not among the extracted files: ${selected.slice(0, 8).join(", ")}`,
        );
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

/**
 * Absolute path to a tar that understands zip.
 *
 * On Windows that means bsdtar in System32; `C:\Windows\System32` is always on
 * PATH but so is Git Bash's `/usr/bin` when the process inherits a shell PATH,
 * and GNU tar wins that race. Everywhere else the plain name is fine.
 */
function resolveTar(): string {
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const bsdtar = join(systemRoot, "System32", "tar.exe");
  return existsSync(bsdtar) ? bsdtar : "tar";
}

/**
 * Compile an archive-entry glob.
 *
 * `*` matches across path separators, because zip entries always carry a
 * top-level directory (`Release/whisper-cli.exe`, `ffmpeg-9.0.1/bin/ffmpeg.exe`)
 * and a single-segment glob could never match them.
 */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

async function sha256File(path: string): Promise<string> {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
}

/** Default per-user data directory for the app. */
export function defaultBinDir(): string {
  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ??
      join(process.env.USERPROFILE ?? ".", "AppData", "Roaming");
    return join(appData, "DobStudio");
  }
  const home = process.env.HOME ?? ".";
  return join(home, ".dobstudio");
}
