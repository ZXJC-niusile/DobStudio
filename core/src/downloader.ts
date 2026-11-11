/**
 * Download layer — a thin, deliberately unprivileged wrapper over yt-dlp.
 *
 * SCOPE. There is no authentication path here by design: no `--cookies`, no
 * `--cookies-from-browser`, no `--username/--password`, no `--add-header`, no
 * proxy-credential passthrough. `assertNoAuthFlags` enforces that at runtime so
 * a future refactor cannot quietly reintroduce it.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { readdir, rm } from "node:fs/promises";

import { run } from "./proc.ts";
import type { Sidecar } from "./sidecar.ts";
import type {
  Container,
  DownloadOptions,
  DownloadProgress,
  DownloadResult,
  Lang,
  MediaFormat,
  MediaMeta,
  QualityPref,
} from "./types.ts";

/** Flags that would make the downloader act on the user's behalf elsewhere. */
const FORBIDDEN_FLAGS = [
  "--cookies",
  "--cookies-from-browser",
  "--username",
  "--password",
  "--netrc",
  "--add-header",
  "--cookie",
  "--video-password",
  "--ap-username",
  "--ap-password",
  "--client-certificate",
] as const;

/**
 * Guard used before every yt-dlp invocation.
 *
 * Exported so callers (and tests) can verify the boundary independently of the
 * download path.
 */
export function assertNoAuthFlags(args: readonly string[]): void {
  for (const arg of args) {
    const flag = arg.split("=")[0]!.toLowerCase();
    if ((FORBIDDEN_FLAGS as readonly string[]).includes(flag)) {
      throw new Error(`Refusing to run yt-dlp with ${flag}: out of scope.`);
    }
  }
}

/** Build the yt-dlp `-f` selector for a quality preference. */
export function formatSelector(quality: QualityPref): string {
  switch (quality) {
    case "360p":
      return "bv*[height<=360]+ba/b[height<=360]/b";
    case "480p":
      return "bv*[height<=480]+ba/b[height<=480]/b";
    case "720p":
      return "bv*[height<=720]+ba/b[height<=720]/b";
    case "1080p":
      return "bv*[height<=1080]+ba/b[height<=1080]/b";
    case "best":
      return "bv*+ba/b";
    case "audio-only":
      return "ba/b";
  }
}

function mergeOutputFormat(container: Container): string {
  return container;
}

/**
 * yt-dlp progress line, e.g.
 *   `[download]  45.3% of  147.23MiB at    9.01MiB/s ETA 00:15`
 *   `[download] 100% of 10.00MiB at 5.00MiB/s`
 * Every group after the percentage is optional because yt-dlp omits them on
 * the final line of a finished download.
 */
const PROGRESS_LINE =
  /^\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)?(?:\s+at\s+([\d.]+\s*\w+\/s))?(?:\s+ETA\s+([\d:]+))?/;

/** Ask yt-dlp for metadata without downloading anything. */
export async function probe(
  sidecar: Sidecar,
  url: string,
  signal?: AbortSignal,
): Promise<MediaMeta> {
  const args = [
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    "--no-progress",
    url,
  ];
  assertNoAuthFlags(args);

  const result = await sidecar.run("yt-dlp", args, { timeoutMs: 120_000, signal });
  if (result.code !== 0) {
    throw new Error(
      `yt-dlp probe failed: ${(result.stderr || result.stdout).slice(0, 600)}`,
    );
  }

  let info: Record<string, unknown>;
  try {
    info = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error("yt-dlp returned unparseable metadata JSON");
  }

  const formats = Array.isArray(info.formats) ? info.formats : [];
  const mapped: MediaFormat[] = formats.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const f = raw as Record<string, unknown>;
    const formatId = typeof f.format_id === "string" ? f.format_id : undefined;
    if (formatId === undefined) return [];
    return [
      {
        formatId,
        ext: typeof f.ext === "string" ? f.ext : "",
        width: num(f.width),
        height: num(f.height),
        fps: num(f.fps),
        filesize: num(f.filesize) ?? num(f.filesize_approx),
        vcodec: str(f.vcodec),
        acodec: str(f.acodec),
        abr: num(f.abr),
        formatNote: str(f.format_note),
      },
    ];
  });

  const subLangs = new Set<Lang>();
  for (const key of ["subtitles", "automatic_captions"]) {
    const table = info[key];
    if (typeof table === "object" && table !== null) {
      for (const lang of Object.keys(table as Record<string, unknown>)) {
        subLangs.add(lang);
      }
    }
  }

  const sourceUrl = str(info.webpage_url) ?? str(info.original_url) ?? url;
  return {
    id: str(info.id) ?? hashId(sourceUrl),
    url: sourceUrl,
    title: str(info.title) ?? "untitled",
    durationSec: num(info.duration) ?? 0,
    thumbnailUrl: str(info.thumbnail),
    uploader: str(info.uploader),
    extractor: str(info.extractor_key) ?? str(info.extractor),
    formats: mapped,
    availableSubtitleLangs: [...subLangs].sort(),
  };
}

/**
 * True when the input is a file on disk rather than a URL.
 *
 * This matters because yt-dlp cannot be handed a Windows path at all: it parses
 * `C:/...` as a URL whose scheme is `c` and fails with "Unsupported url scheme".
 * A local file therefore has to bypass the download layer entirely.
 */
export function isLocalPath(input: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) return false;
  if (input.startsWith("file:")) return true;
  return existsSync(input);
}

/** Build metadata for a local file using ffprobe, without touching yt-dlp. */
export async function probeLocal(
  sidecar: Sidecar,
  path: string,
): Promise<MediaMeta> {
  if (!existsSync(path)) {
    throw new Error(`No such file: ${path}`);
  }

  const ffprobe = await sidecar.ensureBinary("ffprobe");
  const result = await sidecar.run(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) {
    throw new Error(`ffprobe failed on ${path}: ${result.stderr.slice(0, 300)}`);
  }

  let info: { format?: { duration?: string }; streams?: { codec_type?: string }[] };
  try {
    info = JSON.parse(result.stdout) as typeof info;
  } catch {
    throw new Error("ffprobe returned unparseable JSON");
  }

  const durationSec = Number.parseFloat(info.format?.duration ?? "");
  const hasAudio = (info.streams ?? []).some((s) => s.codec_type === "audio");
  if (!hasAudio) {
    throw new Error(`${path} has no audio stream, so there is nothing to transcribe.`);
  }

  return {
    id: hashId(path),
    url: path,
    title: basename(path).replace(/\.[^.]+$/, ""),
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    extractor: "local",
    formats: [],
    availableSubtitleLangs: [],
  };
}

/** Download the media (and optionally its own subtitle tracks). */
export async function download(
  sidecar: Sidecar,
  url: string,
  options: DownloadOptions,
  hooks: {
    onProgress?: (progress: DownloadProgress) => void;
    signal?: AbortSignal;
    /** Metadata already fetched by the caller, so yt-dlp is not asked twice. */
    meta?: MediaMeta;
  } = {},
): Promise<DownloadResult> {
  hooks.onProgress?.({ phase: "download", percent: 0 });

  // A local file needs no download and no yt-dlp at all.
  if (isLocalPath(url)) {
    const meta = hooks.meta ?? (await probeLocal(sidecar, url));
    hooks.onProgress?.({ phase: "done", percent: 100 });
    return { mediaPath: url, sourceSubtitlePaths: {}, meta };
  }

  const meta = hooks.meta ?? (await probe(sidecar, url, hooks.signal));

  // yt-dlp must use the managed binary even when ffmpeg is absent from PATH.
  const ffmpeg = await sidecar.ensureBinary("ffmpeg");
  hooks.signal?.throwIfAborted();

  const template = join(
    options.outputDir,
    "%(title).100B-%(id)s.%(ext)s",
  );

  const args: string[] = [
    "--ffmpeg-location", ffmpeg,
    "-f",
    formatSelector(options.quality),
    "--merge-output-format",
    mergeOutputFormat(options.container),
    "--no-warnings",
    "--newline",
    "--no-playlist",
    "--progress",
    "-o",
    template,
    url,
  ];

  if (options.quality === "audio-only") {
    args.unshift("-x", "--audio-format", "m4a", "--audio-quality", "0");
  }

  // Subtitles are deliberately NOT requested here. See fetchSourceSubtitles:
  // a rate-limited or unavailable subtitle track must not fail a media
  // download, because local ASR is a complete fallback.
  assertNoAuthFlags(args);

  const result = await sidecar.run("yt-dlp", args, {
    timeoutMs: 60 * 60 * 1000,
    signal: hooks.signal,
    onStdoutLine: (line) => {
      const progress = parseProgressLine(line);
      if (progress) hooks.onProgress?.(progress);
    },
    onStderrLine: (line) => {
      const progress = parseProgressLine(line);
      if (progress) hooks.onProgress?.(progress);
    },
  });

  if (result.code !== 0 && !hooks.signal?.aborted) {
    throw new Error(
      `yt-dlp download failed: ${(result.stderr || result.stdout).slice(0, 800)}`,
    );
  }

  const mediaPath = findPrimaryOutput(options.outputDir, meta.id, result.stdout);
  if (!mediaPath) {
    throw new Error("Download reported success but no output file was found.");
  }

  const sourceSubtitlePaths = options.writeSubs
    ? await fetchSourceSubtitles(sidecar, url, options, meta, hooks.signal)
    : {};

  hooks.onProgress?.({ phase: "done", percent: 100 });
  return { mediaPath, sourceSubtitlePaths, meta };
}

/**
 * Fetch the source's own subtitle tracks, tolerating failure.
 *
 * This runs as its own yt-dlp invocation with `--skip-download`, and every
 * failure is swallowed. Subtitles are an optimisation: if the source has a
 * track in the language the user asked for, the pipeline skips local ASR
 * entirely, and if it does not, ASR produces the same result more slowly.
 * Treating a rate-limited subtitle endpoint as a fatal error — which is what
 * happens when the flags ride along with the media download — turns an
 * optimisation into a reason to fail the whole job.
 */
export async function fetchSourceSubtitles(
  sidecar: Sidecar,
  url: string,
  options: DownloadOptions,
  meta: MediaMeta,
  signal?: AbortSignal,
): Promise<Record<Lang, string>> {
  if (options.subLangs.length === 0) return {};
  // A local file has no remote subtitle endpoint to query.
  if (isLocalPath(url)) return {};

  const ffmpeg = await sidecar.ensureBinary("ffmpeg");
  signal?.throwIfAborted();
  const args: string[] = [
    "--ffmpeg-location", ffmpeg,
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    options.subLangs.join(","),
    "--convert-subs",
    "srt",
    "--no-warnings",
    "--no-playlist",
    "-o",
    join(options.outputDir, "%(title).100B-%(id)s.%(ext)s"),
    url,
  ];
  assertNoAuthFlags(args);

  const result = await sidecar.run("yt-dlp", args, {
    timeoutMs: 5 * 60 * 1000,
    signal,
  });
  if (result.code !== 0) {
    // Not an error: fall through to local transcription.
    return {};
  }

  return collectSourceSubtitles(options.outputDir, meta.id, options.subLangs);
}

/** Parse one yt-dlp `[download]` progress line. */
export function parseProgressLine(line: string): DownloadProgress | undefined {
  if (!line.includes("[download]")) return undefined;
  const match = PROGRESS_LINE.exec(line);
  if (!match) return undefined;
  const [, percent, size, speed, eta] = match;
  return {
    phase: "download",
    percent: Number.parseFloat(percent!),
    downloadedBytes: parseHumanBytes(size),
    totalBytes: parseHumanBytes(size),
    speed: speed?.trim(),
    eta: eta?.trim(),
  };
}

function parseHumanBytes(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /^([\d.]+)\s*(\w+)$/.exec(raw.trim());
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();
  const multiplier: Record<string, number> = {
    B: 1,
    K: 1e3,
    KB: 1e3,
    KIB: 1024,
    M: 1e6,
    MB: 1e6,
    MIB: 1024 ** 2,
    G: 1e9,
    GB: 1e9,
    GIB: 1024 ** 3,
    T: 1e12,
    TB: 1e12,
    TIB: 1024 ** 4,
  };
  const factor = multiplier[unit];
  return factor === undefined ? undefined : Math.round(value * factor);
}

/**
 * Locate the downloaded media file.
 *
 * yt-dlp prints the merge/destination path, but the wording differs across
 * versions, so fall back to scanning the output directory for a file that
 * carries the video id.
 */
function findPrimaryOutput(
  outputDir: string,
  id: string,
  stdout: string,
): string | undefined {
  const mergeMatch = /\[Merger\] Merging formats into "(.+)"/.exec(stdout);
  if (mergeMatch && existsSync(mergeMatch[1]!)) return mergeMatch[1];

  const destMatch = /\[download\] Destination: (.+)/.exec(stdout);
  if (destMatch) {
    const candidate = destMatch[1]!.trim();
    if (existsSync(candidate)) return candidate;
  }

  if (!existsSync(outputDir)) return undefined;
  const suffix = `-${id}.`;
  const entries = readdirSync(outputDir);
  const media = entries
    .filter((name) => name.includes(suffix))
    .filter((name) => !/\.(srt|vtt|ass|part|ytdl|tmp|json|jpg|jpeg|png|webp)$/i.test(name))
    .sort();
  return media.length > 0 ? join(outputDir, media[media.length - 1]!) : undefined;
}

async function collectSourceSubtitles(
  outputDir: string,
  id: string,
  wanted: readonly Lang[],
): Promise<Record<Lang, string>> {
  const out: Record<Lang, string> = {};
  if (!existsSync(outputDir)) return out;
  const entries = await readdir(outputDir);
  for (const name of entries) {
    if (!name.endsWith(".srt")) continue;
    if (!name.includes(`-${id}.`)) continue;
    const stem = basename(name, ".srt");
    const lang = stem.slice(stem.indexOf(`-${id}.`) + id.length + 2);
    if (lang === "" || lang === undefined) continue;
    if (wanted.length > 0 && !wanted.includes(lang)) continue;
    out[lang] = join(outputDir, name);
  }
  return out;
}

/** Remove a partially downloaded file set. */
export async function cleanupOutputs(outputDir: string, id: string): Promise<void> {
  if (!existsSync(outputDir)) return;
  const entries = await readdir(outputDir);
  await Promise.all(
    entries
      .filter((name) => name.includes(`-${id}.`))
      .map((name) => rm(join(outputDir, name), { force: true })),
  );
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Stable, filesystem-safe id for a source URL. */
export function hashId(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i += 1) {
    hash = (hash * 31 + url.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
