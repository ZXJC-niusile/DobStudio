import { test } from "node:test";
import assert from "node:assert/strict";
import { outputArtifacts } from "../src/artifacts.ts";
test("mixed and dry outputs both remain visible with distinct labels", () => {
  const outputs = outputArtifacts({
    videoPath: "dry.mp4",
    audioPath: "dry.wav",
    videoPathWithBgm: "mixed.mp4",
    audioPathWithBgm: "mixed.wav",
    bgmPath: "bgm.wav",
    projectRevision: 2,
  });
  assert.deepEqual(
    outputs.map((x) => x.path),
    ["mixed.mp4", "mixed.wav", "dry.mp4", "dry.wav", "bgm.wav"],
  );
  assert.equal(outputs[0]?.label, "混音视频（含伴奏）");
  assert.equal(outputs[2]?.label, "干声视频（无伴奏）");
});
test("legacy and subtitle output records remain readable without exposing unknown fields", () => {
  assert.deepEqual(outputArtifacts(undefined), []);
  assert.deepEqual(
    outputArtifacts({
      videoPath: "out.mp4",
      srtPath: "out.srt",
      privatePath: "secret",
      audioPathWithBgm: null,
    }).map((x) => x.path),
    ["out.mp4", "out.srt"],
  );
});
