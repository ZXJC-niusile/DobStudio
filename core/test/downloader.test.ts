import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertNoAuthFlags,
  formatSelector,
  hashId,
  parseProgressLine,
} from "../src/downloader.ts";
import { WHISPER_MODELS } from "../src/catalog.ts";

describe("formatSelector", () => {
  it("caps height for each quality tier", () => {
    assert.match(formatSelector("720p"), /height<=720/);
    assert.match(formatSelector("1080p"), /height<=1080/);
    assert.match(formatSelector("360p"), /height<=360/);
  });

  it("prefers separate video and audio streams", () => {
    assert.match(formatSelector("best"), /bv\*\+ba/);
  });

  it("selects audio only for the audio tier", () => {
    assert.equal(formatSelector("audio-only"), "ba/b");
  });
});

describe("assertNoAuthFlags", () => {
  it("accepts a normal argument vector", () => {
    assert.doesNotThrow(() =>
      assertNoAuthFlags(["-f", "bv*+ba", "--newline", "https://example.com/v"]),
    );
  });

  it("rejects cookie and credential flags", () => {
    for (const flag of [
      "--cookies",
      "--cookies=cookies.txt",
      "--cookies-from-browser",
      "--cookies-from-browser=chrome",
      "--username",
      "--password",
      "--netrc",
      "--add-header",
      "--video-password",
      "--ap-username",
    ]) {
      assert.throws(
        () => assertNoAuthFlags([flag, "x"]),
        /Refusing to run yt-dlp/,
        `expected ${flag} to be refused`,
      );
    }
  });

  it("is case-insensitive", () => {
    assert.throws(() => assertNoAuthFlags(["--COOKIES"]), /Refusing/);
  });
});

describe("parseProgressLine", () => {
  it("reads a full progress line", () => {
    const progress = parseProgressLine(
      "[download]  45.3% of  147.23MiB at    9.01MiB/s ETA 00:15",
    );
    assert.ok(progress);
    assert.equal(progress!.phase, "download");
    assert.equal(progress!.percent, 45.3);
    assert.equal(progress!.speed, "9.01MiB/s");
    assert.equal(progress!.eta, "00:15");
  });

  it("reads a line without size or ETA", () => {
    const progress = parseProgressLine("[download] 100% of 10.00MiB at 5.00MiB/s");
    assert.equal(progress?.percent, 100);
  });

  it("ignores non-download lines", () => {
    assert.equal(parseProgressLine("[youtube] abc: Downloading webpage"), undefined);
    assert.equal(parseProgressLine("[info] Writing video metadata"), undefined);
  });

  it("returns undefined for a destination line", () => {
    assert.equal(
      parseProgressLine("[download] Destination: out.mp4"),
      undefined,
    );
  });
});

describe("hashId", () => {
  it("is stable and differs between URLs", () => {
    assert.equal(hashId("https://a.example/1"), hashId("https://a.example/1"));
    assert.notEqual(hashId("https://a.example/1"), hashId("https://a.example/2"));
  });

  it("produces a filesystem-safe token", () => {
    assert.match(hashId("https://a.example/1"), /^[a-z0-9]+$/);
  });
});

describe("WHISPER_MODELS", () => {
  it("covers every model tier", () => {
    for (const key of ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"]) {
      assert.ok(WHISPER_MODELS[key as keyof typeof WHISPER_MODELS]);
    }
  });

  it("orders sizes monotonically up to medium", () => {
    const sizes = (["tiny", "base", "small", "medium"] as const).map(
      (k) => WHISPER_MODELS[k].approxBytes,
    );
    for (let i = 1; i < sizes.length; i += 1) {
      assert.ok(sizes[i]! > sizes[i - 1]!);
    }
  });
});
