/**
 * Intermediate audio format for transcription.
 *
 * whisper.cpp reads flac, mp3, ogg and wav directly, so the 16 kHz mono WAV
 * this project has always written is not the only option — it is simply the
 * largest one. A two-hour video as 16 kHz mono PCM is ~230 MB on disk for the
 * duration of one job; the same audio as MP3 is ~30 MB.
 *
 * The trade-off is real and was measured, not assumed: re-transcribing the same
 * file from MP3 produced visibly different text (`and so do I` became
 * `and so far`), because MP3 is lossy even at high quality. So WAV stays the
 * default and MP3 is opt-in, for anyone who would rather have the disk back.
 */

import type { AudioFormat, TranscribeOptions } from "./types.ts";

/** How loud the warning about MP3 quality loss should be. */
export const AUDIO_FORMAT_NOTE: Record<AudioFormat, string> = {
  wav: "Lossless. Best transcription quality, ~8× the disk space of MP3.",
  mp3: "Lossy. Measurably changes the transcript, but uses ~8× less disk space.",
};

/** ffmpeg codec arguments for each supported intermediate format. */
export function audioCodecArgs(format: AudioFormat): string[] {
  switch (format) {
    case "wav":
      return ["-c:a", "pcm_s16le"];
    case "mp3":
      // -q:a 4 is roughly 165 kbit/s at 16 kHz mono, which is transparent
      // enough for speech and about a tenth of the WAV's size.
      return ["-c:a", "libmp3lame", "-q:a", "4"];
  }
}

/** File extension whisper.cpp should be handed for each format. */
export function audioExtension(format: AudioFormat): string {
  return format === "mp3" ? "mp3" : "wav";
}

/** Resolve the format a request asked for, defaulting to the safe choice. */
export function resolveAudioFormat(options: TranscribeOptions): AudioFormat {
  return options.audioFormat ?? "wav";
}
