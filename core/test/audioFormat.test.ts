import assert from "node:assert/strict";
import { test } from "node:test";
import { audioCodecArgs, resolveAudioFormat } from "../src/audioFormat.ts";

test("audio codecs match the selected format", () => {
  assert.deepEqual(audioCodecArgs("wav"), ["-c:a", "pcm_s16le"]);
  assert.deepEqual(audioCodecArgs("mp3"), ["-c:a", "libmp3lame", "-q:a", "4"]);
});
test("transcription defaults to WAV and accepts MP3", () => {
  assert.equal(resolveAudioFormat({ model: "tiny" }), "wav");
  assert.equal(
    resolveAudioFormat({ model: "tiny", audioFormat: "mp3" }),
    "mp3",
  );
});
