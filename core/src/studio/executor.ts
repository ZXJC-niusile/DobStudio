import { resolveDubbingConfig } from "./contracts.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { renderAss } from "../ass.ts";
import { burnSubtitles, aspectRatioFilter } from "../clips.ts";
import { runPipeline } from "../pipeline.ts";
import { run } from "../proc.ts";
import type { Sidecar } from "../sidecar.ts";
import type { Executor } from "./jobs.ts";
export function createExecutor(
  root: string,
  engineRoot: string,
  sidecar: Sidecar,
): Executor {
  return async ({
    jobId,
    project,
    settings,
    request,
    inputVideo,
    signal,
    progress,
  }) => {
    const out = join(root, "tasks", jobId);
    await mkdir(out, { recursive: true });
    signal.throwIfAborted();
    if (request.kind === "export-video") {
      if (!inputVideo || !existsSync(inputVideo))
        throw new Error("Download or import the source video before export");
      const burn = request.options.burnSubtitles !== false;
      const ratio = request.options.aspectRatio || "original";
      let videoPath: string;
      let assPath: string | undefined;
      if (burn) {
        progress("writing-subtitles");
        assPath = join(out, "subtitles.ass");
        await writeFile(assPath, renderAss(project.cues), "utf8");
        progress("burning-subtitles");
        videoPath = await burnSubtitles(
          sidecar,
          inputVideo,
          assPath,
          join(out, "subtitled.mp4"),
          signal,
          ratio,
        );
      } else {
        progress("exporting-video");
        videoPath = join(out, "exported.mp4");
        const ratioFilter = aspectRatioFilter(ratio);
        const args = [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-i",
          inputVideo,
        ];
        if (ratioFilter) {
          args.push(
            "-vf",
            ratioFilter,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "copy",
          );
        } else {
          args.push("-c", "copy");
        }
        args.push("-movflags", "+faststart", videoPath);
        const res = await sidecar.run("ffmpeg", args, {
          timeoutMs: 60 * 60 * 1000,
          signal,
        });
        if (res.code !== 0)
          throw new Error(`ffmpeg export failed: ${res.stderr.slice(0, 600)}`);
      }
      if (!existsSync(videoPath))
        throw new Error("FFmpeg returned no exported video");
      return {
        artifacts: {
          videoPath,
          ...(assPath ? { assPath } : {}),
          audioSource: request.options.audioSource,
          burnSubtitles: burn,
          aspectRatio: request.options.aspectRatio || "original",
        },
      };
    }
    if (request.kind === "subtitles") {
      const result = await runPipeline(
        {
          url: project.source,
          download: {
            quality: "best",
            container: "mp4",
            writeSubs: true,
            subLangs: [request.options.sourceLang || "en"],
            outputDir: out,
          },
          transcribe: {
            model: request.options.model,
            lang: request.options.sourceLang,
          },
          sourceLang: request.options.sourceLang,
          targetLang: request.options.targetLang,
          provider: settings.provider,
          render: { srt: true, ass: true, splitLongLines: false },
          resume: false,
        },
        {
          sidecar,
          signal,
          onEvent: (e) => {
            if (e.type === "stage") progress(e.stage);
          },
        },
      );
      return {
        artifacts: {
          srtPath: result.bilingualSrtPath,
          assPath: result.bilingualAssPath,
        },
        cues: result.cues.map((c, i) => ({ ...c, index: i + 1 })),
        source: result.mediaPath,
      };
    }
    const ffmpeg = await sidecar.ensureBinary("ffmpeg");
    signal.throwIfAborted();
    const ffprobe = await sidecar.ensureBinary("ffprobe");
    signal.throwIfAborted();
    const { engine, modelPath } = resolveDubbingConfig(
      settings,
      request.options,
    );
    const manifest = {
      version: 1,
      mediaPath: project.source,
      outputDir: out,
      referencePath: request.options.referencePath,
      referenceText: request.options.referenceText,
      referenceLanguage: request.options.referenceLanguage,
      targetLanguage: request.options.targetLanguage,
      engine,
      separateBgm: Boolean(request.options.separateBgm),
      ducking: request.options.ducking !== false,
      bgmVolume: request.options.bgmVolume ?? 0.3,
      xttsModelPath: settings.xttsModelPath,
      modelPath,
      device: settings.device,
      ffmpeg,
      ffprobe,
      cues: project.cues,
    };
    const path = join(out, "manifest.json");
    await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
    let result: Record<string, unknown> | undefined, error: string | undefined;
    const execution = await run(
      settings.python,
      ["-m", "dobstudio_engine", "--manifest", path],
      {
        cwd: engineRoot,
        signal,
        timeoutMs: 24 * 3600 * 1000,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
        onStdoutLine: (line) => {
          try {
            const event = JSON.parse(line);
            if (event.version !== 1) return;
            if (event.type === "stage") progress(String(event.stage));
            if (event.type === "result") result = event.result;
            if (event.type === "error") error = String(event.message);
          } catch {
            /* Ignore non-protocol diagnostics. */
          }
        },
      },
    );
    signal.throwIfAborted();
    if (execution.code !== 0 || execution.timedOut || !result)
      throw new Error(
        error ||
          execution.stderr.slice(-2000) ||
          "Inference worker did not return a result",
      );
    if (typeof result.videoPath !== "string" || !existsSync(result.videoPath))
      throw new Error("Inference worker returned a missing video");
    return { artifacts: result };
  };
}
