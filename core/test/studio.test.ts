import { test } from "node:test";
import assert from "node:assert/strict";
import { Repository } from "../src/studio/repository.ts";
import { Jobs } from "../src/studio/jobs.ts";
import {
  validateCues,
  validateSettings,
  validateTask,
  DEFAULT_SETTINGS,
} from "../src/studio/contracts.ts";
import { aspectRatioFilter } from "../src/clips.ts";
const request = {
  kind: "subtitles" as const,
  options: { model: "base" as const },
};
const cues = [
  { index: 1, startMs: 0, endMs: 1000, text: "hello", translation: "你好" },
];
test("invalid request never takes a project slot", async () => {
  const repo = new Repository(":memory:");
  const p = repo.create("video.mp4");
  const jobs = new Jobs(repo, async () => ({ artifacts: {} }));
  assert.throws(() =>
    jobs.submit(p.id, { ...request, options: { model: "invalid" as never } }),
  );
  assert.equal(jobs.busy(p.id), false);
  assert.equal(repo.jobs().length, 0);
  jobs.submit(p.id, request);
  await jobs.idle();
  assert.equal(repo.jobs()[0]?.status, "done");
  repo.close();
});
test("one owner serializes tasks, rejects same-project work and locks saving", async () => {
  const repo = new Repository(":memory:");
  const p = repo.create("one.mp4"),
    q = repo.create("two.mp4");
  let release!: () => void;
  let active = 0,
    peak = 0;
  const jobs = new Jobs(repo, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((r) => (release = r));
    active--;
    return { artifacts: {} };
  });
  jobs.submit(p.id, request);
  jobs.submit(q.id, request);
  assert.throws(() => jobs.submit(p.id, request));
  assert.throws(() => jobs.save(q.id, 0, cues));
  assert.equal(repo.jobs().filter((j) => j.status === "queued").length, 1);
  release();
  await new Promise((r) => setImmediate(r));
  release();
  await jobs.idle();
  assert.equal(peak, 1);
  repo.close();
});
test("cancelling a queued task does not run it or mark it done", async () => {
  const repo = new Repository(":memory:");
  const p = repo.create("one"),
    q = repo.create("two");
  let calls = 0;
  const jobs = new Jobs(repo, async ({ signal }) => {
    calls++;
    await new Promise<void>((r) =>
      signal.addEventListener("abort", () => r(), { once: true }),
    );
    return { artifacts: {} };
  });
  const first = jobs.submit(p.id, request),
    second = jobs.submit(q.id, request);
  jobs.cancel(second);
  jobs.cancel(first);
  await jobs.idle();
  assert.equal(calls, 1);
  assert.ok(repo.jobs().every((j) => j.status === "cancelled"));
  repo.close();
});
test("failed executor releases slot and settings snapshots do not drift", async () => {
  const repo = new Repository(":memory:");
  const p = repo.create("one");
  let settingsSeen = "";
  const jobs = new Jobs(repo, async ({ settings }) => {
    await Promise.resolve();
    settingsSeen = settings.python;
    throw Error("model failed");
  });
  jobs.submit(p.id, request);
  repo.saveSettings({ python: "changed", modelPath: "", device: "cpu" });
  await jobs.idle();
  assert.equal(settingsSeen, "python");
  assert.equal(jobs.busy(p.id), false);
  assert.equal(repo.jobs()[0]?.error, "model failed");
  repo.close();
});
test("revision checks prevent stale edits, validation prevents overlapping cues", () => {
  const repo = new Repository(":memory:");
  const p = repo.create("one");
  const jobs = new Jobs(repo, async () => ({ artifacts: {} }));
  const saved = jobs.save(p.id, 0, cues);
  assert.equal(saved.revision, 1);
  assert.throws(() => jobs.save(p.id, 0, cues));
  assert.throws(() =>
    validateCues([
      ...cues,
      { index: 2, startMs: 500, endMs: 2000, text: "overlap" },
    ]),
  );
  assert.throws(() => validateCues([{ ...cues[0], startMs: NaN }]));
  repo.close();
});
test("startup marks interrupted work and never resumes stale in-memory slots", () => {
  const repo = new Repository(":memory:");
  const p = repo.create("one");
  repo.insert(
    {
      id: "old",
      projectId: p.id,
      kind: "subtitles",
      status: "running",
      stage: "transcribing",
    },
    {},
  );
  const jobs = new Jobs(repo, async () => ({ artifacts: {} }));
  assert.equal(repo.jobs()[0]?.status, "failed");
  assert.equal(jobs.busy(p.id), false);
  repo.close();
});
test("settings validation handles defaultEngine and xttsModelPath", () => {
  validateSettings({
    ...DEFAULT_SETTINGS,
    defaultEngine: "xtts",
    xttsModelPath: "D:/models/xtts",
  });
  assert.throws(() =>
    validateSettings({
      ...DEFAULT_SETTINGS,
      defaultEngine: "unsupported" as never,
    }),
  );
  assert.throws(() =>
    validateSettings({
      ...DEFAULT_SETTINGS,
      xttsModelPath: 123 as never,
    }),
  );
});
test("task validation supports modular dubbing and export options", () => {
  validateTask({
    kind: "dubbing",
    options: {
      referencePath: "ref.wav",
      referenceText: "hello",
      referenceLanguage: "en",
      targetLanguage: "zh",
      engine: "xtts",
      separateBgm: true,
      ducking: false,
      bgmVolume: 0.45,
    },
  });
  validateTask({
    kind: "export-video",
    options: {
      audioSource: "dubbing-with-bgm",
      burnSubtitles: false,
      aspectRatio: "16:9",
    },
  });
  assert.throws(() =>
    validateTask({
      kind: "dubbing",
      options: {
        referencePath: "ref.wav",
        referenceText: "hello",
        referenceLanguage: "en",
        targetLanguage: "zh",
        engine: "bad" as never,
      },
    }),
  );
  assert.throws(() =>
    validateTask({
      kind: "dubbing",
      options: {
        referencePath: "ref.wav",
        referenceText: "hello",
        referenceLanguage: "en",
        targetLanguage: "zh",
        bgmVolume: 1.5,
      },
    }),
  );
  assert.throws(() =>
    validateTask({
      kind: "export-video",
      options: {
        audioSource: "invalid" as never,
      },
    }),
  );
});
test("jobs submit resolves dubbing-with-bgm audioSource and checks xtts model path", async () => {
  const repo = new Repository(":memory:");
  const p = repo.create("video.mp4");
  repo.save({ ...p, cues, revision: 1 });
  let contextPassed: any;
  const jobs = new Jobs(repo, async (ctx) => {
    contextPassed = ctx;
    return {
      artifacts: {
        videoPath: "dubbed.mp4",
        videoPathWithBgm: "dubbed_with_bgm.mp4",
        backgroundAudio: "included",
      },
    };
  });

  // Test xtts requires xttsModelPath
  repo.saveSettings({ ...DEFAULT_SETTINGS, modelPath: "", xttsModelPath: "" });
  assert.throws(() =>
    jobs.submit(p.id, {
      kind: "dubbing",
      options: {
        referencePath: "ref.wav",
        referenceText: "ref",
        referenceLanguage: "en",
        targetLanguage: "zh",
        engine: "xtts",
      },
    }),
  );

  // Restore settings and submit dubbing
  repo.saveSettings({
    ...DEFAULT_SETTINGS,
    modelPath: "D:/models/cosyvoice",
    xttsModelPath: "D:/models/xtts",
  });
  jobs.submit(p.id, {
    kind: "dubbing",
    options: {
      referencePath: "ref.wav",
      referenceText: "ref",
      referenceLanguage: "en",
      targetLanguage: "zh",
      engine: "xtts",
      separateBgm: true,
      ducking: true,
      bgmVolume: 0.5,
    },
  });
  await jobs.idle();

  // Now submit export-video with dubbing-with-bgm
  jobs.submit(p.id, {
    kind: "export-video",
    options: {
      audioSource: "dubbing-with-bgm",
      burnSubtitles: false,
    },
  });
  await jobs.idle();
  assert.equal(contextPassed.inputVideo, "dubbed_with_bgm.mp4");
  repo.close();
});

test("aspectRatioFilter produces correct scale and pad commands", () => {
  assert.equal(aspectRatioFilter("original"), undefined);
  assert.equal(aspectRatioFilter(undefined), undefined);
  const r169 = aspectRatioFilter("16:9");
  assert.ok(r169 && r169.includes("1920:1080"));
  const r916 = aspectRatioFilter("9:16");
  assert.ok(r916 && r916.includes("1080:1920"));
});

test("XTTS cannot borrow a configured CosyVoice directory or occupy a slot", () => {
  const repo = new Repository(":memory:");
  const p = repo.create("source.mp4");
  repo.save({ ...p, cues });
  repo.saveSettings({
    ...DEFAULT_SETTINGS,
    modelPath: "D:/CosyVoice",
    xttsModelPath: "",
  });
  const jobs = new Jobs(repo, async () => ({ artifacts: {} }));
  assert.throws(
    () =>
      jobs.submit(p.id, {
        kind: "dubbing",
        options: {
          engine: "xtts",
          referencePath: "ref.wav",
          referenceText: "",
          referenceLanguage: "en",
          targetLanguage: "en",
        },
      }),
    /local XTTS/,
  );
  assert.equal(repo.jobs().length, 0);
  assert.equal(jobs.busy(p.id), false);
  repo.close();
});
