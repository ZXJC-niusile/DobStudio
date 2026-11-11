/**
 * Intermediate audio format.
 *
 * The choice is a real trade-off that was measured, not guessed: MP3 uses about
 * an eighth of the disk of a 16 kHz mono WAV, and it measurably changes the
 * transcript. These tests pin the parts that must not drift — which codec
 * arguments each format produces, and that the file extension matches, since a
 * mismatch would hand whisper.cpp a file it refuses to read.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUDIO_FORMAT_NOTE,
  audioCodecArgs,
  audioExtension,
  resolveAudioFormat,
} from "../src/audioFormat.ts";

describe("audioCodecArgs", () => {
  it("produces uncompressed PCM for wav", () => {
    assert.deepEqual(audioCodecArgs("wav"), ["-c:a", "pcm_s16le"]);
  });

  it("produces lame for mp3", () => {
    const args = audioCodecArgs("mp3");
    assert.deepEqual(args.slice(0, 2), ["-c:a", "libmp3lame"]);
    // A quality setting must be present, or ffmpeg picks a default bitrate
    // tuned for music rather than speech.
    assert.ok(args.includes("-q:a"), "no quality flag was emitted");
  });

  it("emits no duplicate codec flags", () => {
    // ffmpeg applies the last -c:a and warns about the rest; a duplicate means
    // a caller bug.
    for (const format of ["wav", "mp3"] as const) {
      const args = audioCodecArgs(format);
      assert.equal(
        args.filter((arg) => arg === "-c:a").length,
        1,
        `${format} emitted more than one -c:a`,
      );
    }
  });
});

describe("audioExtension", () => {
  it("matches the codec", () => {
    assert.equal(audioExtension("wav"), "wav");
    assert.equal(audioExtension("mp3"), "mp3");
  });

  it("agrees with what whisper.cpp accepts", () => {
    // whisper.cpp --help lists: flac, mp3, ogg, wav. A format outside that set
    // would fail at transcription time, long after the extraction succeeded.
    for (const format of ["wav", "mp3"] as const) {
      assert.ok(
        ["flac", "mp3", "ogg", "wav"].includes(audioExtension(format)),
        `${audioExtension(format)} is not a format whisper.cpp reads`,
      );
    }
  });
});

describe("resolveAudioFormat", () => {
  it("defaults to wav when nothing is specified", () => {
    assert.equal(resolveAudioFormat({ model: "tiny" }), "wav");
  });

  it("honours an explicit choice", () => {
    assert.equal(resolveAudioFormat({ model: "tiny", audioFormat: "mp3" }), "mp3");
    assert.equal(resolveAudioFormat({ model: "tiny", audioFormat: "wav" }), "wav");
  });
});

describe("AUDIO_FORMAT_NOTE", () => {
  it("explains both formats, including the cost of mp3", () => {
    assert.match(AUDIO_FORMAT_NOTE.wav, /lossless/i);
    assert.match(AUDIO_FORMAT_NOTE.mp3, /lossy/i);
  });
});
