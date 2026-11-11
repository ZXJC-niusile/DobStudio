/**
 * Cover-extraction tests.
 *
 * The mock sidecar's ffmpeg writes a plausible file for any output path, so
 * these tests exercise the decision logic — which source is preferred, when a
 * downloaded "image" is rejected, and when nothing is produced — rather than
 * real image decoding.
 */

import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import { coverPathFor, fetchCover } from "../src/cover.ts";
import { Sidecar } from "../src/sidecar.ts";
import type { MediaMeta } from "../src/types.ts";

const MOCK = join(import.meta.dirname, "fixtures", "mock-binaries.mjs");

class MockSidecar extends Sidecar {
  constructor(binDir: string) {
    super({ binDir });
  }
  override async launcherFor(name: string) {
    return {
      command: process.execPath,
      prefixArgs: [MOCK],
      env: { DOBSTUDIO_MOCK: name === "whisper" ? "whisper-cli" : name },
    };
  }
  override async ensureBinary(name: string): Promise<string> {
    return join(this.binDir, "bin", `${name}.mock`);
  }
  override async ensureModel(): Promise<string> {
    return join(this.binDir, "models", "ggml-mock.bin");
  }
}

let dir: string;
let sidecar: MockSidecar;
let mediaPath: string;

/** A minimal MediaMeta, as the pipeline would build it. */
function meta(overrides: Partial<MediaMeta> = {}): MediaMeta {
  return {
    id: "m1",
    url: "https://example.com/v",
    title: "Test",
    durationSec: 20,
    formats: [],
    availableSubtitleLangs: [],
    ...overrides,
  };
}

/**
 * A JPEG header padded past the engine's minimum-size threshold.
 *
 * `fetchCover` rejects bodies under 1 KiB because a real thumbnail is never
 * that small — a 12-byte magic-number stub would be treated as an error page.
 */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
  Buffer.alloc(2048, 0x5a),
]);

before(() => {
  dir = mkdtempSync(join(tmpdir(), "dobstudio-cover-"));
  sidecar = new MockSidecar(dir);
  mediaPath = join(dir, "video.mp4");
  writeFileSync(mediaPath, Buffer.from("fake-media"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("coverPathFor", () => {
  it("derives a .cover.jpg beside the media", () => {
    assert.equal(coverPathFor("C:/a/b.mp4"), "C:/a/b.cover.jpg");
    assert.equal(coverPathFor("C:/a/b.mkv"), "C:/a/b.cover.jpg");
  });

  it("handles a path with no extension", () => {
    assert.equal(coverPathFor("C:/a/b"), "C:/a/b.cover.jpg");
  });

  it("keeps dots that are part of a directory name", () => {
    assert.equal(coverPathFor("C:/a.b/c"), "C:/a.b/c.cover.jpg");
  });
});

describe("fetchCover", () => {
  it("falls back to a frame when there is no thumbnail URL", async () => {
    const cover = await fetchCover(sidecar, mediaPath, meta());
    assert.ok(cover !== undefined, "a cover was produced");
    assert.equal(cover, coverPathFor(mediaPath));
    assert.ok(existsSync(cover!), "the file exists on disk");
  });

  it("reuses an existing cover instead of regenerating it", async () => {
    const first = await fetchCover(sidecar, mediaPath, meta());
    assert.ok(first !== undefined);
    writeFileSync(first!, Buffer.from("PREVIOUS"));

    const second = await fetchCover(sidecar, mediaPath, meta());
    assert.equal(second, first);
    assert.equal(readFileSync(second!, "utf8"), "PREVIOUS", "the existing file was left alone");
  });

  it("prefers the source thumbnail over extracting a frame", async () => {
    // A server that serves a real JPEG: the engine must not call ffmpeg.
    const target = join(dir, "with-thumb.mp4");
    writeFileSync(target, Buffer.from("fake-media"));

    const spy = new MockSidecar(dir);
    let ffmpegCalled = false;
    const realLauncher = spy.launcherFor.bind(spy);
    spy.launcherFor = async (name: string) => {
      if (name === "ffmpeg") ffmpegCalled = true;
      return realLauncher(name);
    };

    const cover = await fetchCover(spy, target, meta({ thumbnailUrl: thumbUrl }));

    assert.ok(cover !== undefined, "the downloaded thumbnail was used");
    assert.equal(ffmpegCalled, false, "ffmpeg must not run when the URL works");
  });

  it("rejects a thumbnail URL that returns an HTML error page", async () => {
    const target = join(dir, "html-thumb.mp4");
    writeFileSync(target, Buffer.from("fake-media"));
    // Served body is large but not an image, so it must fall through to ffmpeg.
    const cover = await fetchCover(sidecar, target, meta({ thumbnailUrl: htmlUrl }));
    assert.ok(cover !== undefined, "fell back to a frame");
  });

  it("returns undefined when the thumbnail URL is unreachable and ffmpeg fails", async () => {
    const target = join(dir, "no-cover.mp4");
    writeFileSync(target, Buffer.from("fake-media"));

    const broken = new MockSidecar(dir);
    broken.launcherFor = async () => {
      throw new Error("ffmpeg unavailable");
    };

    const cover = await fetchCover(broken, target, meta({ thumbnailUrl: deadUrl }));
    assert.equal(cover, undefined, "no cover, and no throw");
  });
});

/* A tiny HTTP server serving two bodies: a real JPEG and a big HTML page. */
let server: Server;
let thumbUrl: string;
let htmlUrl: string;
let deadUrl: string;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/thumb.jpg") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(JPEG);
    } else if (req.url === "/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>${"x".repeat(4096)}</body></html>`);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  thumbUrl = `http://127.0.0.1:${addr.port}/thumb.jpg`;
  htmlUrl = `http://127.0.0.1:${addr.port}/page.html`;
  deadUrl = `http://127.0.0.1:${addr.port}/missing.jpg`;
});

after(() => {
  server.close();
});
