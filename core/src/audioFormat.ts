import type { AudioFormat, TranscribeOptions } from "./types.ts";

/** ffmpeg codec arguments for each supported intermediate format. */
export function audioCodecArgs(format: AudioFormat): string[] {
  switch (format) {
    case "wav":
      return ["-c:a", "pcm_s16le"];
    case "mp3":
      return ["-c:a", "libmp3lame", "-q:a", "4"];
  }
}

/** Resolve the format a request asked for, defaulting to WAV. */
export function resolveAudioFormat(options: TranscribeOptions): AudioFormat {
  return options.audioFormat ?? "wav";
}
