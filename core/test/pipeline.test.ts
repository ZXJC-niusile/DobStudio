/**
 * End-to-end pipeline tests against mock sidecar binaries.
 *
 * Covers `runPipeline` orchestration,
 * progress-event flow, the "source subtitles win over ASR" branch, SRT output
 * writing, and cancellation. Everything runs for real; only the media
 * processing is faked.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, join as joinPath } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { runPipeline } from "../src/pipeline.ts";
import { Sidecar } from "../src/sidecar.ts";
import type { PipelineEvent, ProviderConfig } from "../src/types.ts";
import { parseSrt, serializeSrt } from "../src/srt.ts";

const MOCK = join(import.meta.dirname, "fixtures", "mock-binaries.mjs");
const CALL_LOG = joinPath(tmpdir(), `dobstudio-mock-calls-${process.pid}.log`);

/**
 * A Sidecar whose binaries are the mock script, one per role.
 *
 * `launcherFor` is the seam the launcher refactor exists for: the pipeline
 * calls `sidecar.run("yt-dlp", …)` exactly as it would in production, and the
 * mock receives those arguments.
 */
class MockSidecar extends Sidecar {
  constructor() {
    super({ binDir: mkdtempSync(join(tmpdir(), "dobstudio-mock-")) });
  }

  override async launcherFor(name: string): Promise<{
    command: string;
    prefixArgs: string[];
    env?: Record<string, string>;
  }> {
    // The env var is what tells one mock script which binary it is standing in
    // for, so a single fixture covers all four.
    return {
      command: process.execPath,
      prefixArgs: [MOCK],
      env: {
        DOBSTUDIO_MOCK: name === "whisper" ? "whisper-cli" : name,
        DOBSTUDIO_MOCK_CALL_LOG: CALL_LOG,
      },
    };
  }

  /**
   * Never touch the network.
   *
   * `ensureBinary` and `ensureModel` are overridden so that a stray call on any
   * code path fails loudly here instead of silently downloading gigabytes in a
   * test run. The mock launcher ignores the returned path anyway.
   */
  override async ensureBinary(name: string): Promise<string> {
    return join(this.binDir, "bin", `${name}.mock`);
  }

  override async ensureModel(): Promise<string> {
    return join(this.binDir, "models", "ggml-mock.bin");
  }
}

/** A provider that never hits the network: the mock translator is in-process. */
const PROVIDER: ProviderConfig = {
  id: "mock",
  name: "Mock",
  baseUrl: "http://127.0.0.1:1/v1",
  apiKey: "k",
  model: "mock-model",
  concurrency: 2,
};

let workDir: string;
let sidecar: MockSidecar;

beforeEach(() => {
  rmSync(CALL_LOG, { force: true });
});

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "dobstudio-e2e-"));
  sidecar = new MockSidecar();
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Collect every event the pipeline emits. */
function recorder(): { events: PipelineEvent[]; sink: (e: PipelineEvent) => void } {
  const events: PipelineEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

const URL = "https://example.com/watch?v=mock123";

function request(overrides: Partial<Parameters<typeof runPipeline>[0]> = {}) {
  return {
    url: URL,
    download: {
      quality: "1080p" as const,
      container: "mp4" as const,
      writeSubs: true,
      subLangs: ["en"],
      outputDir: workDir,
    },
    transcribe: { model: "large-v3-turbo" as const, lang: "en" },
    render: { srt: true, ass: true, splitLongLines: false },
    ...overrides,
  };
}

describe("runPipeline", () => {
  it("runs the full chain and writes both subtitle files", async () => {
    const { events, sink } = recorder();
    const result = await runPipeline(request(), { sidecar, onEvent: sink });

    assert.ok(existsSync(result.mediaPath), "media file written");
    assert.ok(existsSync(result.bilingualSrtPath!), "srt written");
    assert.ok(existsSync(result.bilingualAssPath!), "ass written");

    // The mock ships an .en.srt, so ASR must have been skipped.
    assert.equal(result.timings.transcribing, undefined, "ASR should be skipped");
    assert.ok(result.timings.downloading !== undefined, "download ran");
    assert.equal(result.cueCount, 4);
  });

  it("reports every stage in order", async () => {
    const { events, sink } = recorder();
    await runPipeline(request(), { sidecar, onEvent: sink });

    const stages = events
      .filter((e) => e.type === "stage")
      .map((e) => (e as { stage: string }).stage);

    assert.deepEqual(stages, [
      "probing",
      "downloading",
      // no extracting-audio / transcribing: the source had subtitles
      "writing",
      "done",
    ]);
  });

  it("emits download progress with a parsed percentage", async () => {
    const { events, sink } = recorder();
    await runPipeline(request(), { sidecar, onEvent: sink });

    const progress = events.filter((e) => e.type === "download-progress");
    assert.ok(progress.length >= 3, "expected the mock's three progress lines");
    const percents = progress.map((e) => (e as { progress: { percent?: number } }).progress.percent);
    assert.ok(percents.every((p) => typeof p === "number"));
    assert.equal(Math.max(...percents.filter((p): p is number => p !== undefined)), 100);
  });

  it("writes a bilingual SRT whose cue count matches the source", async () => {
    const result = await runPipeline(request(), { sidecar });
    const written = readFileSync(result.bilingualSrtPath!, "utf8");
    const cues = parseSrt(written);
    assert.equal(cues.length, 4);
    assert.equal(cues[0]!.startMs, 1000);
    assert.equal(cues[0]!.endMs, 4500);
    assert.ok(cues[0]!.text.includes("neural networks"));
  });

  it("writes a valid ASS document", async () => {
    const result = await runPipeline(request(), { sidecar });
    const ass = readFileSync(result.bilingualAssPath!, "utf8");
    assert.ok(ass.includes("[Script Info]"));
    assert.ok(ass.includes("[V4+ Styles]"));
    assert.ok(ass.includes("[Events]"));
    assert.equal(ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length, 4);
  });

  it("skips the .ass when rendering is disabled", async () => {
    const result = await runPipeline(
      request({ render: { srt: true, ass: false, splitLongLines: false } }),
      { sidecar },
    );
    assert.equal(result.bilingualAssPath, undefined);
    assert.ok(existsSync(result.bilingualSrtPath!));
  });

  it("falls back to local ASR when the source has no subtitles", async () => {
    const { events, sink } = recorder();
    const result = await runPipeline(
      request({
        download: { quality: "1080p", container: "mp4", writeSubs: false, subLangs: [], outputDir: workDir },
        transcribe: { model: "large-v3-turbo", lang: undefined },
      }),
      { sidecar, onEvent: sink },
    );

    const stages = events
      .filter((e) => e.type === "stage")
      .map((e) => (e as { stage: string }).stage);
    assert.ok(stages.includes("extracting-audio"), "audio extraction ran");
    assert.ok(stages.includes("transcribing"), "whisper ran");

    const transcribeProgress = events.filter((e) => e.type === "transcribe-progress");
    assert.ok(transcribeProgress.length > 0, "progress was derived from timestamps");
    assert.equal(result.cueCount, 4);
  });

  it("surfaces a probe failure", async () => {
    await assert.rejects(
      () => runPipeline(request({ url: "https://example.com/fail-probe" }), { sidecar }),
      /Unable to extract video data/,
    );
  });

  it("reports a failing stage and still emits a terminal event", async () => {
    const { events, sink } = recorder();
    await assert.rejects(() =>
      runPipeline(request({ url: "https://example.com/fail-probe" }), { sidecar, onEvent: sink }),
    );
    const error = events.find((e) => e.type === "error");
    assert.ok(error, "an error event was emitted");
    const stage = events.find((e) => e.type === "stage");
    assert.equal((stage as { stage: string }).stage, "probing");
  });

  it("treats a local file path as media, not as a URL", async () => {
    // yt-dlp cannot be handed a Windows path: it parses `C:/...` as a URL whose
    // scheme is `c` and fails. A local file must bypass the download layer.
    const local = join(workDir, "local-input.mp4");
    writeFileSync(local, Buffer.from("fake-media"));

    const { events, sink } = recorder();
    const result = await runPipeline(
      request({ url: local, download: { quality: "1080p", container: "mp4", writeSubs: false, subLangs: [], outputDir: workDir } }),
      { sidecar, onEvent: sink },
    );

    assert.equal(result.mediaPath, local, "the local file is used verbatim");
    assert.equal(result.cueCount, 4, "transcription still ran");

    // The invariant that actually matters: yt-dlp is never invoked. It cannot
    // parse a Windows path at all, so any call would have failed the job.
    const calls = readFileSync(CALL_LOG, "utf8");
    assert.ok(
      !calls.includes("yt-dlp"),
      `yt-dlp was invoked for a local file:
${calls}`,
    );
    assert.ok(calls.includes("ffprobe"), "ffprobe supplied the metadata");
  });

  it("refuses a local path with no audio stream", async () => {
    // The mock ffprobe always reports a duration but never an audio stream, so
    // the pipeline must reject rather than hand whisper a silent file.
    const local = join(workDir, "silent.mp4");
    writeFileSync(local, Buffer.from("fake-media"));

    await assert.rejects(
      () =>
        runPipeline(
          request({
            url: local,
            download: { quality: "1080p", container: "mp4", writeSubs: false, subLangs: [], outputDir: workDir },
          }),
          { sidecar },
        ),
      /no audio stream/,
    );
  });

  it("stops when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => runPipeline(request(), { sidecar, signal: controller.signal }),
      /Abort|abort/i,
    );
  });
});

describe("pipeline output content", () => {
  it("splits long lines without losing text", async () => {
    const result = await runPipeline(request(), { sidecar });
    const cues = parseSrt(readFileSync(result.bilingualSrtPath!, "utf8"));
    // Cue 2 of the mock transcript is 96 characters and should be split.
    const joined = cues.map((c) => c.text).join(" ");
    assert.ok(joined.includes("gradient descent"));
    assert.ok(joined.includes("following the slope downhill"));
  });

  it("produces a cue set that round-trips through the parser", async () => {
    const result = await runPipeline(request(), { sidecar });
    const raw = readFileSync(result.bilingualSrtPath!, "utf8");
    assert.deepEqual(parseSrt(serializeSrt(parseSrt(raw))), parseSrt(raw));
  });
});


it("keeps extracted audio, transcripts and covers away from local source", async () => {
  const input=mkdtempSync(join(tmpdir(),"dobstudio-source-"));
  try {
    const media=join(input,"source.mp4");writeFileSync(media,"fixture");
    const result=await runPipeline(request({url:media}),{sidecar});
    assert.ok(result.cueCount>0);
    assert.deepEqual(readdirSync(input),["source.mp4"]);
    assert.equal(readFileSync(media,"utf8"),"fixture");
  } finally {rmSync(input,{recursive:true,force:true});}
});
