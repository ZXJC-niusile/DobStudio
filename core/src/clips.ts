/**
 * Clip cutting and subtitle burn-in.
 *
 * Two cutting modes, because they answer different needs:
 *
 *  - `copy`   seeks and copies the stream. Instant, frame-accurate only at
 *             keyframes, so a cut can start a second late.
 *  - `reencode` decodes and re-encodes. Frame-exact, and the only way to burn
 *             subtitles in, at the cost of time.
 *
 * The default is `copy` for trimming and `reencode` whenever subtitles are
 * involved, since an accurate cut with the wrong subtitles is useless.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

import { run } from "./proc.ts";
import type { Sidecar } from "./sidecar.ts";

export type CutMode = "copy" | "reencode";

export interface CutRequest {
  inputPath: string;
  outputPath: string;
  startMs: number;
  endMs: number;
  mode?: CutMode;
  /** Burn this .ass/.srt into the video (forces re-encode). */
  subtitlePath?: string;
  signal?: AbortSignal;
}

export interface CutResult {
  outputPath: string;
  /** True when the requested span had to be clamped to the media duration. */
  clamped: boolean;
  durationMs: number;
}

/** Cut one span out of a media file. */
export async function cutClip(
  sidecar: Sidecar,
  request: CutRequest,
): Promise<CutResult> {
  if (!existsSync(request.inputPath)) {
    throw new Error(`input not found: ${request.inputPath}`);
  }

  const totalMs = Math.round(((await probeDurationSec(sidecar, request.inputPath)) ?? 0) * 1000);
  let startMs = Math.max(0, Math.round(request.startMs));
  let endMs = Math.round(request.endMs);
  let clamped = false;

  if (totalMs > 0) {
    if (startMs > totalMs) {
      startMs = totalMs;
      clamped = true;
    }
    if (endMs > totalMs) {
      endMs = totalMs;
      clamped = true;
    }
  }
  if (endMs <= startMs) {
    throw new Error(
      `empty clip range: ${startMs}ms → ${endMs}ms${totalMs > 0 ? ` (media is ${totalMs}ms)` : ""}`,
    );
  }

  await mkdir(dirname(request.outputPath), { recursive: true });

  // `-ss` before `-i` is the fast seek; `-to` is absolute on the output clock.
  const args: string[] = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-ss",
    formatSeconds(startMs),
    "-i",
    request.inputPath,
    "-to",
    formatSeconds(endMs - startMs),
  ];

  const needsReencode = request.mode === "reencode";

  if (request.subtitlePath !== undefined) {
    if (!existsSync(request.subtitlePath)) {
      throw new Error(`subtitle file not found: ${request.subtitlePath}`);
    }
    const filter = subtitleFilter(request.subtitlePath);
    args.push("-vf", filter, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac");
  } else if (needsReencode) {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac");
  } else {
    args.push("-c", "copy");
  }

  args.push("-movflags", "+faststart", request.outputPath);

  const result = await sidecar.run("ffmpeg", args, {
    timeoutMs: 60 * 60 * 1000,
    signal: request.signal,
  });
  if (result.code !== 0) {
    throw new Error(`ffmpeg cut failed: ${result.stderr.slice(0, 600)}`);
  }
  if (!existsSync(request.outputPath)) {
    throw new Error("ffmpeg reported success but wrote no clip.");
  }

  return { outputPath: request.outputPath, clamped, durationMs: endMs - startMs };
}

/**
 * Generate a scale and pad filter for 16:9 or 9:16 aspect ratios.
 */
export function aspectRatioFilter(
  ratio?: "original" | "16:9" | "9:16",
): string | undefined {
  if (ratio === "16:9") {
    return "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black";
  }
  if (ratio === "9:16") {
    return "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black";
  }
  return undefined;
}

/** Burn a subtitle file into a full-length video. */
export async function burnSubtitles(
  sidecar: Sidecar,
  inputPath: string,
  subtitlePath: string,
  outputPath: string,
  signal?: AbortSignal,
  aspectRatio?: "original" | "16:9" | "9:16",
): Promise<string> {
  const filters: string[] = [];
  const ratioFilter = aspectRatioFilter(aspectRatio);
  if (ratioFilter) filters.push(ratioFilter);
  filters.push(subtitleFilter(subtitlePath));

  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    inputPath,
    "-vf",
    filters.join(","),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  const result = await sidecar.run("ffmpeg", args, {
    timeoutMs: 60 * 60 * 1000,
    signal,
  });
  if (result.code !== 0) {
    throw new Error(`ffmpeg burn-in failed: ${result.stderr.slice(0, 600)}`);
  }
  return outputPath;
}

/**
 * Build the ffmpeg `subtitles` filter for a path.
 *
 * Windows paths break the filter's `:` separator and its escaping rules, so
 * the path is converted to forward slashes and every `:` and `'` escaped.
 * Getting this wrong is the single most common cause of a silently empty
 * subtitle track on Windows.
 */
export function subtitleFilter(subtitlePath: string): string {
  const normalised = subtitlePath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const ext = subtitlePath.toLowerCase().split(".").pop();
  if (ext === "ass" || ext === "ssa") {
    return `ass='${normalised.replace(/'/g, "\\'")}'`;
  }
  return `subtitles='${normalised.replace(/'/g, "\\'")}'`;
}

async function probeDurationSec(sidecar: Sidecar, path: string): Promise<number | undefined> {
  const result = await sidecar.run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) return undefined;
  const value = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(value) ? value : undefined;
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/** Suggested output path for a clip, avoiding collisions. */
export function clipOutputPath(
  outputDir: string,
  inputPath: string,
  startMs: number,
): string {
  const stem = basename(inputPath).replace(/\.[^.]+$/, "");
  const stamp = Math.round(startMs / 1000);
  return join(outputDir, `${stem}.clip-${stamp}s.mp4`);
}
