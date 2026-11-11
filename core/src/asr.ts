/**
 * Local speech recognition via whisper.cpp.
 *
 * whisper.cpp is treated as a black box that speaks SubRip: we hand it a
 * 16 kHz mono WAV and read back an `.srt`. That keeps the engine free of any
 * native binding and means a stack swap costs nothing here.
 */

import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { audioCodecArgs, audioExtension } from "./audioFormat.ts";
import type { AudioFormat } from "./types.ts";
import { readFile, rm } from "node:fs/promises";

import { run } from "./proc.ts";
import type { Sidecar } from "./sidecar.ts";
import type { Cue, TranscribeOptions } from "./types.ts";
import { parseSrt } from "./srt.ts";

/**
 * Decode any media file to the 16 kHz mono audio whisper.cpp expects.
 *
 * The output format defaults to WAV, which is lossless and what whisper.cpp
 * handles most directly. MP3 is offered because a two-hour video's intermediate
 * WAV is ~230 MB against ~30 MB for the same audio, at the cost of a
 * measurably different transcript.
 */
export async function extractAudio(
  sidecar: Sidecar,
  inputPath: string,
  outputAudio: string,
  signal?: AbortSignal,
  format: AudioFormat = "wav",
): Promise<void> {
  const args: string[] = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    inputPath,
    "-vn",
    "-ar",
    "16000",
    "-ac",
    "1",
    ...audioCodecArgs(format),
    outputAudio,
  ];
  const result = await sidecar.run("ffmpeg", args, {
    timeoutMs: 60 * 60 * 1000,
    signal,
  });
  if (result.code !== 0) {
    throw new Error(`ffmpeg audio extraction failed: ${result.stderr.slice(0, 600)}`);
  }
  if (!existsSync(outputAudio)) {
    throw new Error("ffmpeg reported success but wrote no audio file.");
  }
}

/** Duration in seconds, via ffprobe. Used to derive transcription progress. */
export async function mediaDurationSec(
  sidecar: Sidecar,
  filePath: string,
): Promise<number | undefined> {
  const result = await sidecar.run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) return undefined;
  const value = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(value) ? value : undefined;
}

const SEGMENT_LINE =
  /^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)$/;

/**
 * Transcribe an audio file and return cues.
 *
 * Progress is derived from the timestamps whisper prints as it goes, divided
 * by the total duration — that works across whisper.cpp versions, unlike
 * parsing its progress bar.
 */
export async function transcribe(
  sidecar: Sidecar,
  audioPath: string,
  outputBase: string,
  options: TranscribeOptions,
  hooks: {
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<Cue[]> {
  const modelPath = await sidecar.ensureModel(options.model);

  const totalSec = (await mediaDurationSec(sidecar, audioPath)) ?? 0;

  const args: string[] = [
    "-m",
    modelPath,
    "-f",
    audioPath,
    "-osrt",
    "-of",
    outputBase,
    "-t",
    String(options.threads ?? defaultThreads()),
  ];
  args.push("-l", options.lang ?? "auto");
  if (options.translateToEnglish) args.push("--translate");

  const result = await sidecar.run("whisper", args, {
    timeoutMs: 6 * 60 * 60 * 1000,
    signal: hooks.signal,
    onStdoutLine: (line) => {
      const match = SEGMENT_LINE.exec(line.trim());
      if (!match || totalSec <= 0) return;
      const endMs =
        Number(match[5]!) * 3_600_000 +
        Number(match[6]!) * 60_000 +
        Number(match[7]!) * 1000 +
        Number(match[8]!);
      hooks.onProgress?.(Math.min(99, (endMs / (totalSec * 1000)) * 100));
    },
    onStderrLine: (line) => {
      const match = /progress\s*=\s*(\d{1,3})%/.exec(line);
      if (match) hooks.onProgress?.(Number(match[1]!));
    },
  });

  if (result.code !== 0 && !hooks.signal?.aborted) {
    throw new Error(`whisper.cpp failed: ${result.stderr.slice(0, 800)}`);
  }

  const srtPath = `${outputBase}.srt`;
  if (!existsSync(srtPath)) {
    throw new Error("whisper.cpp finished but produced no .srt output.");
  }

  const cues = parseSrt(await readFile(srtPath, "utf8"));
  if (cues.length === 0) {
    throw new Error("whisper.cpp produced an empty transcript.");
  }
  hooks.onProgress?.(100);
  return cues;
}

/** Delete the intermediate WAV and the raw whisper .srt. */
export async function cleanupTranscribeArtifacts(
  audioPath: string,
  outputBase: string,
): Promise<void> {
  await rm(audioPath, { force: true });
  await rm(`${outputBase}.srt`, { force: true });
}

function defaultThreads(): number {
  const cores = availableParallelism();
  return Math.max(2, Math.min(cores, 8));
}

/** Suggested output base for a media file, in a sibling directory. */
export function transcriptBaseFor(mediaPath: string, workDir: string): string {
  const stem = basename(mediaPath).replace(/\.[^.]+$/, "");
  return join(workDir, `${stem}.whisper`);
}

/** Suggested intermediate-audio path for a media file. */
export function audioPathFor(
  mediaPath: string,
  workDir: string,
  format: AudioFormat = "wav",
): string {
  const stem = basename(mediaPath).replace(/\.[^.]+$/, "");
  return join(workDir, `${stem}.16k.${audioExtension(format)}`);
}
