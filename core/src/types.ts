/**
 * Domain types shared by every layer of the engine.
 *
 * The engine is deliberately stack-agnostic: it knows nothing about Electron or
 * any UI framework. It exposes plain async functions plus one orchestration
 * entry point, so a shell can drive it however it likes.
 */

/** BCP-47-ish language tag: "en", "zh-Hans", "pt-BR", "ja", … */
export type Lang = string;

/* ------------------------------------------------------------------ *
 * Media / download
 * ------------------------------------------------------------------ */

export interface MediaFormat {
  formatId: string;
  ext: string;
  width?: number;
  height?: number;
  fps?: number;
  filesize?: number;
  vcodec?: string;
  acodec?: string;
  abr?: number;
  formatNote?: string;
}

export interface MediaMeta {
  /** Stable id derived from the source URL. */
  id: string;
  url: string;
  title: string;
  durationSec: number;
  thumbnailUrl?: string;
  uploader?: string;
  /** yt-dlp extractor key, e.g. "Youtube", "Bilibili". */
  extractor?: string;
  formats: MediaFormat[];
  /** Languages for which the source already carries subtitles. */
  availableSubtitleLangs: Lang[];
}

export type QualityPref =
  | "360p"
  | "480p"
  | "720p"
  | "1080p"
  | "best"
  | "audio-only";

export type Container = "mp4" | "mkv" | "webm";

export interface DownloadOptions {
  quality: QualityPref;
  container: Container;
  /** Write the video's own subtitle tracks next to the media. */
  writeSubs: boolean;
  subLangs: Lang[];
  outputDir: string;
}

export type DownloadPhase =
  | "probe"
  | "download"
  | "postprocess"
  | "done";

export interface DownloadProgress {
  phase: DownloadPhase;
  /** 0..100 */
  percent?: number;
  speed?: string;
  eta?: string;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface DownloadResult {
  mediaPath: string;
  /** Subtitle tracks the source provided, keyed by language. */
  sourceSubtitlePaths: Record<Lang, string>;
  meta: MediaMeta;
}

/* ------------------------------------------------------------------ *
 * Speech recognition
 * ------------------------------------------------------------------ */

/** Intermediate audio format handed to whisper.cpp. */
export type AudioFormat = "wav" | "mp3";

export type WhisperModel =
  | "tiny"
  | "base"
  | "small"
  | "medium"
  | "large-v3"
  | "large-v3-turbo";

export interface TranscribeOptions {
  model: WhisperModel;
  /** Omit for auto-detection. */
  lang?: Lang;
  /** Use whisper's built-in speech→English translation instead of transcribing. */
  translateToEnglish?: boolean;
  threads?: number;
  /**
   * Intermediate audio format. Defaults to `wav` (lossless); `mp3` uses about
   * an eighth of the disk but measurably changes the transcript.
   */
  audioFormat?: AudioFormat;
}

/* ------------------------------------------------------------------ *
 * Subtitles
 * ------------------------------------------------------------------ */

export interface Cue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface BilingualCue extends Cue {
  translation?: string;
}

/* ------------------------------------------------------------------ *
 * Translation provider
 * ------------------------------------------------------------------ */

export interface ProviderConfig {
  id: string;
  /** Display name, e.g. "DeepSeek", "Moonshot", "My local vLLM". */
  name: string;
  /** OpenAI-compatible base URL, e.g. "https://api.deepseek.com/v1". */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Parallel in-flight requests. Default 4. */
  concurrency?: number;
  /** Optional HTTP(S) proxy. */
  proxy?: string;
  /** Max retries per failed batch. Default 3. */
  maxRetries?: number;
}

export interface GlossaryEntry {
  source: string;
  target: string;
  /** When true the term is matched case-insensitively. */
  caseInsensitive?: boolean;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

export interface AssStyleOptions {
  fontFamily: string;
  fontSize: number;
  primaryColor: string;
  secondaryColor: string;
  outlineColor: string;
  backColor: string;
  bold: boolean;
  outline: number;
  shadow: number;
  /** Vertical distance from the bottom edge, in ASS pixels. */
  marginV: number;
  /** Gap between the original line and the translation line. */
  lineGap: number;
}

/* ------------------------------------------------------------------ *
 * Pipeline
 * ------------------------------------------------------------------ */

/** A span the model flagged as worth watching. */
export interface Highlight {
  startMs: number;
  endMs: number;
  title: string;
  reason: string;
  /** Cue indices the span covers, for traceability. */
  fromCue: number;
  toCue: number;
}

export type PipelineStage =
  | "queued"
  | "probing"
  | "downloading"
  | "extracting-audio"
  | "transcribing"
  | "translating"
  | "highlights"
  | "merging"
  | "writing"
  | "done"
  | "failed"
  | "cancelled";

export type PipelineEvent =
  | { type: "stage"; jobId: string; stage: PipelineStage }
  | { type: "download-progress"; jobId: string; progress: DownloadProgress }
  | { type: "transcribe-progress"; jobId: string; percent: number }
  | {
      type: "translate-progress";
      jobId: string;
      done: number;
      total: number;
    }
  | { type: "log"; jobId: string; level: "info" | "warn" | "error"; message: string }
  | {
      type: "done";
      jobId: string;
      result: PipelineResult;
    }
  | { type: "error"; jobId: string; stage: PipelineStage; message: string };

export interface PipelineRequest {
  url: string;
  download: DownloadOptions;
  transcribe: TranscribeOptions;
  /** Target language for the translation layer. Omit to skip translation. */
  targetLang?: Lang;
  sourceLang?: Lang;
  provider?: ProviderConfig;
  glossary?: GlossaryEntry[];
  /** Ask the model which spans are worth watching. Requires `provider`. */
  highlights?: {
    enabled: boolean;
    maxHighlights?: number;
    outputLang?: Lang;
  };
  /**
   * Skip stages whose output is already on disk from an earlier run of the
   * same request. Defaults to on.
   */
  resume?: boolean;
  render: {
    /** Emit a plain bilingual .srt. */
    srt: boolean;
    /** Emit a styled .ass. */
    ass: boolean;
    /** Split long sentences across several display lines. */
    splitLongLines: boolean;
    style?: AssStyleOptions;
  };
}

export interface PipelineResult {
  jobId: string;
  mediaPath: string;
  /** Original-language cues recovered from the source or from ASR. */
  originalSrtPath?: string;
  bilingualSrtPath?: string;
  bilingualAssPath?: string;
  /** Cover image written beside the media, when one could be produced. */
  coverPath?: string;
  cueCount: number;
  translatedCount: number;
  skippedLineCount: number;
  /** Spans the model flagged as worth watching. */
  highlights: Highlight[];
  /**
   * The final bilingual cue set.
   *
   * Carried in the result rather than re-parsed from disk so the shell can
   * persist it to the library without a second read of the same data.
   */
  cues: BilingualCue[];
  /** Wall-clock milliseconds per stage. */
  timings: Partial<Record<PipelineStage, number>>;
  /** Stages that were skipped because a checkpoint covered them. */
  resumedFrom: PipelineStage[];
}

/* ------------------------------------------------------------------ *
 * Binary / sidecar management
 * ------------------------------------------------------------------ */

export type BinaryName = "yt-dlp" | "ffmpeg" | "ffprobe" | "whisper";

export interface BinaryStatus {
  name: BinaryName;
  present: boolean;
  path?: string;
  version?: string;
}

export interface SidecarProgress {
  name: BinaryName;
  receivedBytes: number;
  totalBytes?: number;
}
