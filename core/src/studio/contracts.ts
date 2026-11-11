import type { BilingualCue, WhisperModel, ProviderConfig } from "../types.ts";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export interface Project {
  id: string;
  name: string;
  source: string;
  revision: number;
  cues: BilingualCue[];
}
export interface Settings {
  python: string;
  modelPath: string;
  xttsModelPath?: string;
  defaultEngine?: "cosyvoice" | "xtts";
  defaultTtsEngine?: "cosyvoice" | "xtts";
  device: "cpu" | "cuda";
  provider?: ProviderConfig;
}
export interface SubtitleOptions {
  model: WhisperModel;
  sourceLang?: string;
  targetLang?: string;
}
export interface DubOptions {
  referencePath: string;
  referenceText: string;
  referenceLanguage: string;
  targetLanguage: string;
  engine?: "cosyvoice" | "xtts";
  separateBgm?: boolean;
  ducking?: boolean;
  bgmVolume?: number;
}
export type ExportAudioSource = "original" | "dubbing" | "dubbing-with-bgm";
export type AspectRatioOption = "original" | "16:9" | "9:16";

export interface ExportVideoOptions {
  audioSource: ExportAudioSource;
  burnSubtitles?: boolean;
  aspectRatio?: AspectRatioOption;
}
export type TaskRequest =
  | { kind: "subtitles"; options: SubtitleOptions }
  | { kind: "dubbing"; options: DubOptions }
  | { kind: "export-video"; options: ExportVideoOptions };
export interface Job {
  id: string;
  projectId: string;
  kind: TaskRequest["kind"];
  status: JobStatus;
  stage: string;
  error?: string;
  result?: Record<string, unknown>;
}
export interface Snapshot {
  projects: Project[];
  jobs: Job[];
  settings: Settings;
}
export interface DesktopApi {
  snapshot(): Promise<Snapshot>;
  createProject(source: string): Promise<Project>;
  saveCues(
    id: string,
    revision: number,
    cues: BilingualCue[],
  ): Promise<Project>;
  importSrt(id: string, revision: number): Promise<Project | null>;
  exportSrt(id: string): Promise<string | null>;
  mediaUrl(id: string): Promise<string | null>;
  submit(id: string, request: TaskRequest): Promise<string>;
  cancel(id: string): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
  pick(
    kind: "media" | "reference" | "model" | "python",
  ): Promise<string | null>;
  reveal(path: string): Promise<void>;
  status(): Promise<{ name: string; present: boolean }[]>;
  install(model: WhisperModel): Promise<void>;
  onChange(callback: () => void): () => void;
}
export const DEFAULT_SETTINGS: Settings = {
  python: "python",
  modelPath: "",
  xttsModelPath: "",
  defaultEngine: "cosyvoice",
  defaultTtsEngine: "cosyvoice",
  device: "cpu",
};
export function validateCues(value: unknown): asserts value is BilingualCue[] {
  if (!Array.isArray(value) || value.length > 100000)
    throw new Error("Invalid subtitle list");
  let end = 0;
  for (const [i, c] of value.entries()) {
    if (
      !c ||
      typeof c.text !== "string" ||
      (c.translation !== undefined && typeof c.translation !== "string") ||
      !Number.isFinite(c.startMs) ||
      !Number.isFinite(c.endMs) ||
      c.startMs < end ||
      c.endMs <= c.startMs ||
      c.index !== i + 1
    )
      throw new Error(
        `Subtitle ${i + 1}: use ordered, non-overlapping intervals and consecutive indices`,
      );
    end = c.endMs;
  }
}
export function validateSettings(s: Settings): void {
  if (
    !s ||
    typeof s.python !== "string" ||
    !s.python.trim() ||
    typeof s.modelPath !== "string" ||
    !["cpu", "cuda"].includes(s.device)
  )
    throw new Error("Invalid runtime settings");
  if (s.xttsModelPath !== undefined && typeof s.xttsModelPath !== "string")
    throw new Error("Invalid XTTS model path");
  if (
    s.defaultEngine !== undefined &&
    !["cosyvoice", "xtts"].includes(s.defaultEngine)
  )
    throw new Error("Invalid default engine");
  if (
    s.defaultTtsEngine !== undefined &&
    !["cosyvoice", "xtts"].includes(s.defaultTtsEngine)
  )
    throw new Error("Invalid default TTS engine");
  if (
    s.provider &&
    (!s.provider.baseUrl || !s.provider.model || !s.provider.apiKey)
  )
    throw new Error("Provider needs URL, model and key");
}
export function validateTask(t: TaskRequest): void {
  if (!t || !t.options) throw new Error("Invalid task");
  if (t.kind === "subtitles") {
    if (
      ![
        "tiny",
        "base",
        "small",
        "medium",
        "large-v3",
        "large-v3-turbo",
      ].includes(t.options.model)
    )
      throw new Error("Unknown ASR model");
  } else if (t.kind === "export-video") {
    if (
      !["original", "dubbing", "dubbing-with-bgm"].includes(
        t.options.audioSource,
      )
    )
      throw new Error("Choose original audio or current dubbing");
    if (
      t.options.burnSubtitles !== undefined &&
      typeof t.options.burnSubtitles !== "boolean"
    )
      throw new Error("Invalid burnSubtitles option");
    if (
      t.options.aspectRatio !== undefined &&
      !["original", "16:9", "9:16"].includes(t.options.aspectRatio)
    )
      throw new Error("Invalid aspectRatio option");
  } else if (t.kind === "dubbing") {
    for (const key of [
      "referencePath",
      "referenceText",
      "referenceLanguage",
      "targetLanguage",
    ] as const)
      if (typeof t.options[key] !== "string") throw new Error(`Invalid ${key}`);
    if (!t.options.referencePath || !t.options.targetLanguage)
      throw new Error("Reference WAV and target language are required");
    if (
      t.options.engine !== undefined &&
      !["cosyvoice", "xtts"].includes(t.options.engine)
    )
      throw new Error("Invalid TTS engine");
    if (
      t.options.separateBgm !== undefined &&
      typeof t.options.separateBgm !== "boolean"
    )
      throw new Error("Invalid separateBgm option");
    if (
      t.options.ducking !== undefined &&
      typeof t.options.ducking !== "boolean"
    )
      throw new Error("Invalid ducking option");
    if (
      t.options.bgmVolume !== undefined &&
      (!Number.isFinite(t.options.bgmVolume) ||
        t.options.bgmVolume < 0 ||
        t.options.bgmVolume > 1)
    )
      throw new Error("Invalid bgmVolume option");
  } else throw new Error("Unknown task kind");
}

export function resolveDubbingConfig(settings: Settings, options: DubOptions) {
  const engine =
    options.engine ??
    settings.defaultTtsEngine ??
    settings.defaultEngine ??
    "cosyvoice";
  if (engine !== "cosyvoice" && engine !== "xtts")
    throw new Error("Invalid TTS engine");
  const modelPath = (
    engine === "xtts" ? settings.xttsModelPath : settings.modelPath
  )?.trim();
  if (!modelPath)
    throw new Error(
      `Choose a local ${engine === "xtts" ? "XTTS" : "CosyVoice"} model in settings`,
    );
  return { engine, modelPath };
}
