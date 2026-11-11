/**
 * Pipeline orchestration: URL → bilingual subtitle files.
 *
 * The stage order mirrors how the reference product describes itself, and the
 * one meaningful deviation from a naive implementation is step 5: if the source
 * already ships a subtitle track in the requested language, that track wins and
 * local ASR is skipped entirely. Running whisper over a video that already has
 * perfectly good subtitles is wasted time and a worse result.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  audioPathFor,
  cleanupTranscribeArtifacts,
  extractAudio,
  transcribe,
  transcriptBaseFor,
} from "./asr.ts";
import { download, isLocalPath, probe, probeLocal } from "./downloader.ts";
import { renderAss } from "./ass.ts";
import { resolveAudioFormat } from "./audioFormat.ts";
import { fetchCover } from "./cover.ts";
import { extractHighlights } from "./highlights.ts";
import { dropOverlaps, mergeBilingual, splitLongLines, summarise, toFlatBilingual } from "./merge.ts";
import { run } from "./proc.ts";
import {
  CheckpointStore,
  fingerprint,
  jobKey,
  resumePlan,
  type Checkpoint,
} from "./resume.ts";
import type { Sidecar } from "./sidecar.ts";
import { serializeSrt } from "./srt.ts";
import { translateCues } from "./translator.ts";
import type {
  Cue,
  MediaMeta,
  Highlight,
  Lang,
  PipelineEvent,
  PipelineRequest,
  PipelineResult,
  PipelineStage,
} from "./types.ts";
import { parseSrt } from "./srt.ts";

export interface PipelineDeps {
  sidecar: Sidecar;
  signal?: AbortSignal;
  onEvent?: (event: PipelineEvent) => void;
  /**
   * When present, finished stages are recorded here and skipped on a later run
   * of the same request. Omit it for a one-shot run with no persistence.
   */
  checkpoints?: CheckpointStore;
}

/** `Omit` that distributes over a discriminated union instead of collapsing it. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

type PipelineEventInput = DistributiveOmit<PipelineEvent, "jobId">;

let jobCounter = 0;

function nextJobId(): string {
  jobCounter += 1;
  return `job-${Date.now().toString(36)}-${jobCounter}`;
}

export async function runPipeline(
  request: PipelineRequest,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const jobId = nextJobId();
  const { sidecar, signal, onEvent, checkpoints } = deps;
  const timings: Partial<Record<PipelineStage, number>> = {};
  const resumedFrom: PipelineStage[] = [];

  // A fingerprint of everything that changes the output, so a run with a
  // different model or language cannot reuse another run's checkpoint.
  const print = fingerprint(request);
  const key = jobKey(request);
  const done = checkpoints?.completed(key, print) ?? new Map<PipelineStage, Checkpoint>();
  const plan = resumePlan(done);

  const markDone = (stage: PipelineStage, artifact?: string, detail?: string): void => {
    if (checkpoints === undefined) return;
    checkpoints.save(key, { stage, fingerprint: print, artifact, detail });
  };

  const emit = (event: PipelineEventInput): void => {
    onEvent?.({ jobId, ...event } as PipelineEvent);
  };

  const setStage = (stage: PipelineStage): void => {
    emit({ type: "stage", stage });
  };

  const log = (level: "info" | "warn" | "error", message: string): void => {
    emit({ type: "log", level, message });
  };

  /** Run a stage, recording how long it took. */
  async function stage<T>(
    name: PipelineStage,
    body: () => Promise<T>,
  ): Promise<T> {
    setStage(name);
    const startedAt = Date.now();
    try {
      return await body();
    } finally {
      timings[name] = Date.now() - startedAt;
    }
  }

  const outputDir = request.download.outputDir;
  await mkdir(outputDir, { recursive: true });

  let originalCues: Cue[] = [];
  let translations: string[] = [];
  let mediaPath = "";
  /** Source subtitle tracks, populated only by a fresh download. */
  let sourceSubtitles: Record<Lang, string> | undefined;

  // Hoisted to `const` so the narrowing survives into the `stage` closures.
  const sourceLang: Lang | undefined = request.sourceLang;

  try {
    /*
     * 1 — metadata, then 2 — download.
     *
     * These are one step for a remote URL: `download` probes internally, so
     * probing separately here would ask yt-dlp twice. For a local file there is
     * no probe stage at all — yt-dlp cannot parse a Windows path (it reads
     * `C:/...` as a URL whose scheme is `c`), so the metadata comes from
     * ffprobe inside `download`.
     */
    const local = isLocalPath(request.url);

    const meta = await stage("probing", async () => {
      if (plan.skipProbe && done.get("probing")?.detail !== undefined) {
        resumedFrom.push("probing");
        log("info", "Reusing cached metadata.");
        return JSON.parse(done.get("probing")!.detail!) as MediaMeta;
      }
      log("info", local ? `Reading local file ${basename(request.url)}` : `Probing ${request.url}`);
      const fresh = local
        ? await probeLocal(sidecar, request.url)
        : await probe(sidecar, request.url, signal);
      markDone("probing", undefined, JSON.stringify(fresh));
      return fresh;
    });
    log("info", `Found: ${meta.title} (${meta.durationSec}s)`);

    if (plan.skipDownload && plan.mediaPath !== undefined) {
      resumedFrom.push("downloading");
      mediaPath = plan.mediaPath;
      log("info", `Reusing downloaded media: ${basename(mediaPath)}`);
    } else {
      const downloaded = await stage("downloading", async () => {
        return download(sidecar, request.url, request.download, {
          signal,
          meta,
          onProgress: (progress) => emit({ type: "download-progress", progress }),
        });
      });
      mediaPath = downloaded.mediaPath;
      sourceSubtitles = downloaded.sourceSubtitlePaths;
      if (!local) markDone("downloading", mediaPath);
      log("info", local ? `Input: ${basename(mediaPath)}` : `Downloaded ${basename(mediaPath)}`);
    }

    /* 3 — prefer a source subtitle track --------------------------------- */
    /*
     * Which source subtitle track to prefer.
     *
     * The user picks one language in the UI — the language they expect to hear.
     * If the source happens to carry subtitles in that same language, those are
     * strictly better than a local transcription, so the ASR hint doubles as
     * the source-subtitle preference. An explicit `sourceLang` still wins.
     */
    const asrLang = request.transcribe.lang;
    const preferredSubLang =
      sourceLang ??
      (asrLang !== undefined && asrLang !== "auto" ? asrLang : undefined);
    // Source subtitles are only worth consulting on a fresh download; a resumed
    // run has no map to consult, and local ASR covers it anyway.
    const sourceSubPath =
      sourceSubtitles !== undefined && preferredSubLang !== undefined
        ? sourceSubtitles[preferredSubLang]
        : undefined;

    if (sourceSubPath !== undefined && existsSync(sourceSubPath)) {
      log("info", `Using the source's own ${preferredSubLang} subtitles; skipping ASR.`);
      originalCues = parseSrt(await readFileUtf8(sourceSubPath));
    } else {
      /* 4 — audio extraction --------------------------------------------- */
      const workDir = outputDir;
      const audioFormat = resolveAudioFormat(request.transcribe);
      const audioPath = audioPathFor(mediaPath, workDir, audioFormat);
      const transcriptBase = transcriptBaseFor(mediaPath, workDir);

      if (plan.skipAudio && plan.transcriptSrt !== undefined) {
        // Both the WAV and the transcript survived; re-read the transcript.
        resumedFrom.push("extracting-audio");
        resumedFrom.push("transcribing");
        log("info", "Reusing the transcript from the previous run.");
        originalCues = parseSrt(await readFileUtf8(plan.transcriptSrt));
      } else {
        if (plan.skipAudio && existsSync(audioPath)) {
          resumedFrom.push("extracting-audio");
          log("info", "Reusing the decoded audio.");
        } else {
          await stage("extracting-audio", async () => {
            log("info", `Decoding audio to 16 kHz mono ${audioFormat.toUpperCase()}`);
            return extractAudio(sidecar, mediaPath, audioPath, signal, audioFormat);
          });
          markDone("extracting-audio", audioPath);
        }

        /* 5 — local transcription ---------------------------------------- */
        originalCues = await stage("transcribing", async () => {
          log("info", `Transcribing locally with whisper.cpp (${request.transcribe.model})`);
          return transcribe(sidecar, audioPath, transcriptBase, request.transcribe, {
            signal,
            onProgress: (percent) => emit({ type: "transcribe-progress", percent }),
          });
        });
        markDone("transcribing", `${transcriptBase}.srt`);
      }
    }
    log("info", `${originalCues.length} source cues`);

    /* 6 — translation ---------------------------------------------------- */
    let skippedLineCount = 0;
    // Hoisted so the narrowing survives into the `stage` closure.
    const targetLang: Lang | undefined = request.targetLang;
    const provider = request.provider;

    if (targetLang !== undefined && provider !== undefined) {
      const result = await stage("translating", async () => {
        return translateCues(originalCues, {
          sourceLang,
          targetLang,
          provider,
          glossary: request.glossary,
          signal,
          onProgress: (done, total) => emit({ type: "translate-progress", done, total }),
          onLog: log,
        });
      });
      translations = result.translations;
      skippedLineCount = result.skippedCount;
      if (skippedLineCount > 0) {
        log("warn", `${skippedLineCount} cues came back untranslated.`);
      }
      log(
        "info",
        `Translated ${result.translations.filter((t) => t !== "").length}/${originalCues.length} cues in ${result.requestCount} requests`,
      );
      markDone("translating", undefined, String(result.translations.filter((t) => t !== "").length));
    }

    /* 7 — optional highlight extraction --------------------------------- */
    const highlights: Highlight[] = [];
    const highlightRequest = request.highlights;
    if (
      highlightRequest?.enabled === true &&
      targetLang !== undefined &&
      provider !== undefined &&
      originalCues.length > 0
    ) {
      await stage("highlights", async () => {
        log("info", "Extracting highlights");
        return extractHighlights(originalCues, {
          provider,
          outputLang: highlightRequest.outputLang ?? targetLang,
          maxHighlights: highlightRequest.maxHighlights ?? 8,
          signal,
        });
      }).then((found) => {
        highlights.push(...found);
        log("info", `${found.length} highlights`);
      }).catch((error: unknown) => {
        // Highlights are additive; a failure here must not fail the job.
        log("warn", `highlight extraction failed: ${(error as Error).message}`);
      });
    }

    /* 8 — merge and reshape --------------------------------------------- */
    let bilingual = mergeBilingual(originalCues, translations);
    if (request.render.splitLongLines) {
      bilingual = splitLongLines(bilingual);
    }
    bilingual = dropOverlaps(bilingual);

    /* 9 — write ---------------------------------------------------------- */
    const stem = basename(mediaPath).replace(/\.[^.]+$/, "");
    const result: PipelineResult = {
      jobId,
      mediaPath,
      cueCount: bilingual.length,
      translatedCount: bilingual.filter((c) => c.translation !== undefined).length,
      skippedLineCount,
      highlights,
      cues: bilingual,
      timings,
      resumedFrom,
    };

    await stage("writing", async () => {
      if (request.render.srt) {
        const path = join(outputDir, `${stem}.bilingual.srt`);
        await writeFile(path, serializeSrt(toFlatBilingual(bilingual)), "utf8");
        result.bilingualSrtPath = path;
      }
      if (request.render.ass) {
        const path = join(outputDir, `${stem}.bilingual.ass`);
        await writeFile(path, renderAss(bilingual, { style: request.render.style }), "utf8");
        result.bilingualAssPath = path;
      }
      if (request.targetLang === undefined) {
        // No translation requested: the original transcript is the deliverable.
        const path = join(outputDir, `${stem}.original.srt`);
        await writeFile(path, serializeSrt(originalCues), "utf8");
        result.originalSrtPath = path;
      }

      // Best-effort: a missing cover must not fail a finished job.
      try {
        const cover = await fetchCover(sidecar, mediaPath, meta, signal, outputDir);
        if (cover !== undefined) result.coverPath = cover;
      } catch (error) {
        log("warn", `cover extraction failed: ${(error as Error).message}`);
      }
    });

    const { cueCount, translatedCount } = summarise(bilingual);
    log("info", `Done: ${cueCount} cues, ${translatedCount} translated`);
    setStage("done");
    emit({ type: "done", result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal?.aborted) {
      setStage("cancelled");
      log("warn", "Cancelled by user.");
      throw new DOMException("Cancelled", "AbortError");
    }
    setStage("failed");
    log("error", message);
    emit({ type: "error", stage: "failed", message });
    throw error;
  }
}

/** Fetch the version string of every sidecar binary. */
export async function sidecarReport(sidecar: Sidecar): Promise<string> {
  const statuses = await sidecar.status();
  return statuses
    .map((s) => `${s.name}: ${s.present ? (s.version ?? "present") : "not installed"}`)
    .join("\n");
}

/** Verify the binaries can actually execute a trivial command. */
export async function healthCheck(sidecar: Sidecar): Promise<boolean> {
  const result = await sidecar.run("yt-dlp", ["--version"], { timeoutMs: 20_000 });
  return result.code === 0;
}

async function readFileUtf8(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

export type { Lang };
