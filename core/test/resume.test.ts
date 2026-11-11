/**
 * Resume tests.
 *
 * The property that matters is not "a checkpoint row exists" but "the second
 * run does not redo the work". So these tests run the pipeline twice against
 * the same mock binaries and count invocations: a stage that was skipped must
 * not have been called again.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";

import { runPipeline } from "../src/pipeline.ts";
import { Sidecar } from "../src/sidecar.ts";
import {
  CheckpointStore,
  fingerprint,
  jobKey,
  resumePlan,
} from "../src/resume.ts";
import { parseSrt } from "../src/srt.ts";
import type { PipelineEvent, PipelineRequest } from "../src/types.ts";

const MOCK = join(import.meta.dirname, "fixtures", "mock-binaries.mjs");
const CALL_LOG = join(tmpdir(), `dobstudio-mock-calls-${process.pid}.log`);

class MockSidecar extends Sidecar {
  constructor(binDir: string) {
    super({ binDir });
  }
  override async launcherFor(name: string) {
    return {
      command: process.execPath,
      prefixArgs: [MOCK],
      env: {
        DOBSTUDIO_MOCK: name === "whisper" ? "whisper-cli" : name,
        DOBSTUDIO_MOCK_CALL_LOG: CALL_LOG,
      },
    };
  }
  override async ensureBinary(name: string): Promise<string> {
    return join(this.binDir, "bin", `${name}.mock`);
  }
  override async ensureModel(): Promise<string> {
    return join(this.binDir, "models", "ggml-mock.bin");
  }
}

let workDir: string;
let sidecar: MockSidecar;
let db: DatabaseSync;
let store: CheckpointStore;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "dobstudio-resume-"));
  sidecar = new MockSidecar(workDir);
  db = new DatabaseSync(":memory:");
  store = new CheckpointStore(db);
  rmSync(CALL_LOG, { force: true });
});

after(() => {
  db.close();
});

const URL = "https://example.com/watch?v=mock123";

function request(overrides: Partial<PipelineRequest> = {}): PipelineRequest {
  return {
    url: URL,
    download: {
      quality: "1080p",
      container: "mp4",
      writeSubs: false,
      subLangs: [],
      outputDir: workDir,
    },
    transcribe: { model: "large-v3-turbo", lang: "en" },
    render: { srt: true, ass: false, splitLongLines: false },
    ...overrides,
  };
}

/** How many times each mock binary was invoked since the log was cleared. */
function callCounts(): Record<string, number> {
  if (!existsSync(CALL_LOG)) return {};
  const lines = readFileSync(CALL_LOG, "utf8").split("\n").filter((l) => l !== "");
  const counts: Record<string, number> = {};
  for (const line of lines) {
    const binary = line.split(" ")[0]!;
    counts[binary] = (counts[binary] ?? 0) + 1;
  }
  return counts;
}

function recorder(): { events: PipelineEvent[]; sink: (e: PipelineEvent) => void } {
  const events: PipelineEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

describe("fingerprint", () => {
  it("is stable for the same request", () => {
    assert.equal(fingerprint(request()), fingerprint(request()));
  });

  it("changes when the ASR model changes", () => {
    const a = fingerprint(request());
    const b = fingerprint(request({ transcribe: { model: "tiny", lang: "en" } }));
    assert.notEqual(a, b, "a tiny transcript must not satisfy a large-v3 run");
  });

  it("changes when the target language changes", () => {
    assert.notEqual(
      fingerprint(request({ targetLang: "zh-Hans" })),
      fingerprint(request({ targetLang: "ja" })),
    );
  });

  it("changes when the provider model changes", () => {
    const provider = {
      id: "p",
      name: "P",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      model: "m1",
    };
    assert.notEqual(
      fingerprint(request({ targetLang: "zh-Hans", provider })),
      fingerprint(request({ targetLang: "zh-Hans", provider: { ...provider, model: "m2" } })),
    );
  });

  it("ignores the output directory", () => {
    // Moving the output folder should not invalidate a transcript.
    const a = fingerprint(request());
    const b = fingerprint(
      request({ download: { ...request().download, outputDir: "C:/elsewhere" } }),
    );
    assert.equal(a, b);
  });

  it("ignores glossary ordering", () => {
    const a = fingerprint(
      request({ glossary: [{ source: "a", target: "甲" }, { source: "b", target: "乙" }] }),
    );
    const b = fingerprint(
      request({ glossary: [{ source: "b", target: "乙" }, { source: "a", target: "甲" }] }),
    );
    assert.equal(a, b);
  });
});

describe("resumePlan", () => {
  it("skips nothing when there are no checkpoints", () => {
    const plan = resumePlan(new Map());
    assert.equal(plan.skipProbe, false);
    assert.equal(plan.skipDownload, false);
    assert.equal(plan.skipAudio, false);
  });

  it("skips a stage whose artifact is present", () => {
    const file = join(workDir, "media.mp4");
    writeFileSync(file, "x");
    const plan = resumePlan(
      new Map([
        [
          "downloading" as const,
          { stage: "downloading" as const, fingerprint: "f", artifact: file },
        ],
      ]),
    );
    assert.equal(plan.skipDownload, true);
    assert.equal(plan.mediaPath, file);
  });

  it("reports a stage as skippable when handed one with an artifact", () => {
    // `resumePlan` is pure: it trusts the map it is given. The existence check
    // lives in `CheckpointStore.completed`, and is covered separately below.
    const plan = resumePlan(
      new Map([
        [
          "downloading" as const,
          {
            stage: "downloading" as const,
            fingerprint: "f",
            artifact: join(workDir, "anything.mp4"),
          },
        ],
      ]),
    );
    assert.equal(plan.skipDownload, true);
    assert.equal(plan.mediaPath, join(workDir, "anything.mp4"));
  });
});

describe("CheckpointStore", () => {
  it("round-trips a checkpoint whose artifact exists", () => {
    // `completed` drops rows whose artifact is gone, so the file must be real.
    const media = join(workDir, "a.mp4");
    writeFileSync(media, "x");
    store.save("k1", { stage: "downloading", fingerprint: "f", artifact: media });
    const done = store.completed("k1", "f");
    assert.equal(done.get("downloading")?.artifact, media);
  });

  it("drops a checkpoint whose artifact no longer exists", () => {
    const media = join(workDir, "b.mp4");
    writeFileSync(media, "x");
    store.save("k1", { stage: "downloading", fingerprint: "f", artifact: media });
    rmSync(media, { force: true });
    assert.equal(store.completed("k1", "f").size, 0);
  });

  it("ignores a checkpoint from a different fingerprint", () => {
    store.save("k1", { stage: "downloading", fingerprint: "old", artifact: "/a.mp4" });
    assert.equal(store.completed("k1", "new").size, 0);
  });

  it("invalidate forces a stage to run again", () => {
    store.save("k1", { stage: "transcribing", fingerprint: "f", artifact: "/t.srt" });
    store.invalidate("k1", "transcribing");
    assert.equal(store.completed("k1", "f").size, 0);
  });

  it("clear removes every stage for a key", () => {
    store.save("k1", { stage: "probing", fingerprint: "f" });
    store.save("k1", { stage: "downloading", fingerprint: "f" });
    store.clear("k1");
    assert.equal(store.completed("k1", "f").size, 0);
  });

  it("prune drops checkpoints whose artifact disappeared", () => {
    const gone = join(workDir, "vanished.mp4");
    store.save("k1", { stage: "downloading", fingerprint: "f", artifact: gone });
    assert.equal(store.prune(), 1);
    assert.equal(store.completed("k1", "f").size, 0);
  });
});

describe("runPipeline with checkpoints", () => {
  it("runs every stage on a cold start", async () => {
    const result = await runPipeline(request(), { sidecar, checkpoints: store });
    assert.deepEqual(result.resumedFrom, []);
    const counts = callCounts();
    assert.ok((counts["ffprobe"] ?? 0) >= 1, "ffprobe ran");
    assert.ok((counts["whisper-cli"] ?? 0) >= 1, "whisper ran");
  });

  it("skips transcription on a second run of the same request", async () => {
    await runPipeline(request(), { sidecar, checkpoints: store });
    const firstCounts = callCounts();

    rmSync(CALL_LOG, { force: true });
    const second = await runPipeline(request(), { sidecar, checkpoints: store });
    const secondCounts = callCounts();

    assert.ok(
      second.resumedFrom.includes("transcribing"),
      `expected transcribing to be skipped, got ${JSON.stringify(second.resumedFrom)}`,
    );
    assert.equal(
      secondCounts["whisper-cli"] ?? 0,
      0,
      "whisper must not run again — the transcript was reused",
    );
    assert.ok(
      (secondCounts["whisper-cli"] ?? 0) < (firstCounts["whisper-cli"] ?? 0) + 1,
      "sanity",
    );
    // The output is identical either way.
    assert.equal(second.cueCount, 4);
  });

  it("produces the same cues whether or not it resumed", async () => {
    const cold = await runPipeline(request(), { sidecar, checkpoints: store });
    const coldCues = parseSrt(readFileSync(cold.bilingualSrtPath!, "utf8"));

    rmSync(CALL_LOG, { force: true });
    const warm = await runPipeline(request(), { sidecar, checkpoints: store });
    const warmCues = parseSrt(readFileSync(warm.bilingualSrtPath!, "utf8"));

    assert.deepEqual(warmCues, coldCues, "a resumed run must not change the output");
  });

  it("re-runs transcription when the model changes", async () => {
    await runPipeline(request(), { sidecar, checkpoints: store });
    rmSync(CALL_LOG, { force: true });

    const result = await runPipeline(
      request({ transcribe: { model: "tiny", lang: "en" } }),
      { sidecar, checkpoints: store },
    );

    assert.ok(
      !result.resumedFrom.includes("transcribing"),
      "a different model must not reuse the old transcript",
    );
    assert.ok((callCounts()["whisper-cli"] ?? 0) >= 1, "whisper ran again");
  });

  it("re-runs the download when the media file is gone", async () => {
    const first = await runPipeline(request(), { sidecar, checkpoints: store });
    rmSync(first.mediaPath, { force: true });
    rmSync(CALL_LOG, { force: true });

    const second = await runPipeline(request(), { sidecar, checkpoints: store });
    assert.ok(
      !second.resumedFrom.includes("downloading"),
      "a deleted download cannot be resumed from",
    );
    assert.ok(existsSync(second.mediaPath), "the media was fetched again");
  });

  it("records the stages it completed", async () => {
    await runPipeline(request(), { sidecar, checkpoints: store });
    const done = store.completed(jobKey(request()), fingerprint(request()));
    const stages = [...done.keys()].sort();
    assert.ok(stages.includes("probing"), `saw ${stages.join(",")}`);
    assert.ok(stages.includes("downloading"), `saw ${stages.join(",")}`);
    assert.ok(stages.includes("extracting-audio"), `saw ${stages.join(",")}`);
    assert.ok(stages.includes("transcribing"), `saw ${stages.join(",")}`);
  });

  it("works without a checkpoint store at all", async () => {
    const result = await runPipeline(request(), { sidecar });
    assert.deepEqual(result.resumedFrom, []);
    assert.equal(result.cueCount, 4);
  });
});
