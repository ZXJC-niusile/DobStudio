/**
 * Pure catalog data.
 *
 * This module deliberately imports nothing from `node:*` or from any other
 * engine module, so it is safe to bundle into a browser renderer. The renderer
 * needs the provider list, the model tiers and the default style, but must
 * never pull in the process, filesystem or database layers.
 *
 * Import it as `@dobstudio/core/catalog`.
 */

import type { AssStyleOptions, Lang, ProviderConfig, WhisperModel } from "./types.ts";

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** Env var the CLI and shell fall back to for the key. */
  keyEnv: string;
  /** Where the user gets a key, shown in the UI. */
  keyUrl?: string;
  defaultModel: string;
  /** True when no key is required (a local server). */
  local?: boolean;
  /** Region hint, purely for grouping in the UI. */
  region?: "global" | "china";
  notes?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-4o-mini",
    region: "global",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-4-5",
    region: "global",
    notes: "Anthropic's API is not OpenAI-compatible; use a compatible gateway or the messages API.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    region: "china",
  },
  {
    id: "moonshot",
    name: "Moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    keyEnv: "MOONSHOT_API_KEY",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    defaultModel: "moonshot-v1-8k",
    region: "china",
  },
  {
    id: "zhipu",
    name: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyEnv: "ZHIPU_API_KEY",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    defaultModel: "glm-4-flash",
    region: "china",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    keyEnv: "SILICONFLOW_API_KEY",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
    region: "china",
  },
  {
    id: "volcengine",
    name: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyEnv: "ARK_API_KEY",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    defaultModel: "",
    region: "china",
    notes: "Model names are endpoint ids of the form ep-xxxxxxxx.",
  },
  {
    id: "aliyun",
    name: "Aliyun Bailian",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyEnv: "DASHSCOPE_API_KEY",
    keyUrl: "https://bailian.console.aliyun.com/",
    defaultModel: "qwen-turbo",
    region: "china",
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
    defaultModel: "llama-3.1-8b-instant",
    region: "global",
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
    keyUrl: "https://console.mistral.ai/api-keys",
    defaultModel: "mistral-small-latest",
    region: "global",
  },
  {
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
    defaultModel: "grok-2-latest",
    region: "global",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    keyEnv: "",
    defaultModel: "qwen2.5:7b",
    local: true,
    notes: "No key needed. Start Ollama first, then pick a model you have pulled.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    keyEnv: "",
    defaultModel: "local-model",
    local: true,
    notes: "No key needed. Start LM Studio's local server first.",
  },
  {
    id: "vllm",
    name: "vLLM (local)",
    baseUrl: "http://localhost:8000/v1",
    keyEnv: "",
    defaultModel: "",
    local: true,
    notes: "Start vLLM with --served-model-name, then use that name here.",
  },
];

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Build a `ProviderConfig` from a preset plus a key and model. */
export function configFromPreset(
  preset: ProviderPreset,
  apiKey: string,
  model?: string,
): ProviderConfig {
  return {
    id: preset.id,
    name: preset.name,
    baseUrl: preset.baseUrl,
    apiKey: apiKey === "" && preset.local ? "not-needed" : apiKey,
    model: model !== undefined && model !== "" ? model : preset.defaultModel,
  };
}

/** GGML model weights, keyed by the model tier the UI offers. */
export interface ModelSpec {
  fileName: string;
  approxBytes: number;
  note: string;
}

export const WHISPER_MODELS: Record<WhisperModel, ModelSpec> = {
  tiny: {
    fileName: "ggml-tiny.bin",
    approxBytes: 77_000_000,
    note: "Fastest, usable only for clear single-speaker English.",
  },
  base: {
    fileName: "ggml-base.bin",
    approxBytes: 147_000_000,
    note: "Quick test runs; noticeably more typos.",
  },
  small: {
    fileName: "ggml-small.bin",
    approxBytes: 487_000_000,
    note: "Good for everyday videos; handles Chinese reasonably.",
  },
  medium: {
    fileName: "ggml-medium.bin",
    approxBytes: 1_530_000_000,
    note: "Strong with accents and fast speech; slower.",
  },
  "large-v3": {
    fileName: "ggml-large-v3.bin",
    approxBytes: 3_100_000_000,
    note: "Near-top accuracy across languages.",
  },
  "large-v3-turbo": {
    fileName: "ggml-large-v3-turbo.bin",
    approxBytes: 1_600_000_000,
    note: "Best accuracy-per-byte; the recommended default.",
  },
};

/** Default ASS style, mirrored by the Settings screen. */
export const DEFAULT_ASS_STYLE: AssStyleOptions = {
  fontFamily: "Microsoft YaHei",
  fontSize: 54,
  primaryColor: "#FFFFFF",
  secondaryColor: "#FFD28A",
  outlineColor: "#000000",
  backColor: "#000000",
  bold: true,
  outline: 3,
  shadow: 1,
  marginV: 60,
  lineGap: 6,
};

/** Languages offered by the UI, with the labels users recognise. */
export const TARGET_LANGUAGES: readonly { tag: string; label: string; native: string }[] = [
  { tag: "zh-Hans", label: "Chinese (Simplified)", native: "简体中文" },
  { tag: "zh-Hant", label: "Chinese (Traditional)", native: "繁體中文" },
  { tag: "en", label: "English", native: "English" },
  { tag: "ja", label: "Japanese", native: "日本語" },
  { tag: "ko", label: "Korean", native: "한국어" },
  { tag: "fr", label: "French", native: "Français" },
  { tag: "de", label: "German", native: "Deutsch" },
  { tag: "es", label: "Spanish", native: "Español" },
  { tag: "pt-BR", label: "Portuguese (Brazil)", native: "Português (Brasil)" },
  { tag: "ru", label: "Russian", native: "Русский" },
  { tag: "it", label: "Italian", native: "Italiano" },
];

/** Languages whisper.cpp can be told to expect. */
export const ASR_LANGUAGES: readonly { tag: string; label: string }[] = [
  { tag: "auto", label: "Auto-detect" },
  { tag: "en", label: "English" },
  { tag: "zh", label: "Chinese" },
  { tag: "ja", label: "Japanese" },
  { tag: "ko", label: "Korean" },
  { tag: "es", label: "Spanish" },
  { tag: "fr", label: "French" },
  { tag: "de", label: "German" },
  { tag: "ru", label: "Russian" },
  { tag: "pt", label: "Portuguese" },
  { tag: "it", label: "Italian" },
];

/** Quality tiers offered by the UI, in the order they are useful. */
export const QUALITY_TIERS: readonly { value: string; label: string }[] = [
  { value: "360p", label: "360p" },
  { value: "480p", label: "480p" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p（兼容优先）" },
  { value: "best", label: "最高可用" },
  { value: "audio-only", label: "仅音频（m4a）" },
];

export type { Lang };
