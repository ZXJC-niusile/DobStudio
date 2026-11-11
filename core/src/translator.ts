/**
 * OpenAI-compatible translation client.
 *
 * Cues are translated in batches so one request covers ~30 lines, which keeps
 * per-video request counts low enough for rate limits and cheap enough to
 * matter. The model is contractually required to preserve cue identity, and
 * `parseBatchResponse` verifies that rather than trusting it.
 */

import type {
  Cue,
  GlossaryEntry,
  Lang,
  ProviderConfig,
} from "./types.ts";
import { compileGlossary, enforceGlossary, glossaryPromptLines } from "./glossary.ts";
import { releaseLimit, requestLimit, withSlot } from "./limiter.ts";

export interface TranslateOptions {
  sourceLang?: Lang;
  targetLang: Lang;
  provider: ProviderConfig;
  glossary?: GlossaryEntry[];
  /** Cues per request. Default 30. */
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface TranslateResult {
  /** One entry per input cue, in order. Empty string when untranslated. */
  translations: string[];
  /** Cues the model failed to return. */
  skippedCount: number;
  requestCount: number;
  retryCount: number;
}

const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_RETRIES = 3;

interface WireCue {
  i: number;
  t: string;
}

function systemPrompt(target: Lang, source: Lang | undefined, glossaryLines: readonly string[]): string {
  const direction = source ? `from ${source} ` : "";
  return [
    `You are a subtitle translator. Translate subtitle cues ${direction}into ${target}.`,
    "",
    "Rules — follow every one:",
    "1. Reply with a JSON array only. No prose, no markdown code fence.",
    '2. Each element is exactly {"i": <the cue index>, "t": "<translation>"}.',
    "3. Emit one element per input cue. Same count, same indices, same order.",
    "4. Never merge, split, reorder or drop cues. Never renumber them.",
    '5. Keep a literal \\n inside "t" where the source had one.',
    "6. Leave bracketed speaker labels and sound cues such as [Music] untranslated.",
    "7. Translate meaning, not word order. Keep it short enough to read on screen.",
    ...(glossaryLines.length > 0
      ? [
          "",
          "Terminology — render these exactly, every time:",
          ...glossaryLines,
        ]
      : []),
  ].join("\n");
}

/** Translate every cue, returning a same-length array of translations. */
export async function translateCues(
  cues: readonly Cue[],
  options: TranslateOptions,
): Promise<TranslateResult> {
  const {
    provider,
    targetLang,
    sourceLang,
    glossary = [],
    batchSize = DEFAULT_BATCH_SIZE,
    signal,
    onProgress,
    onLog,
  } = options;

  const translations = new Array<string>(cues.length).fill("");
  if (cues.length === 0) {
    return { translations, skippedCount: 0, requestCount: 0, retryCount: 0 };
  }

  const terms = compileGlossary(glossary);
  const glossaryLines = glossaryPromptLines(glossary);
  const wanted = Math.max(1, provider.concurrency ?? DEFAULT_CONCURRENCY);
  const maxRetries = Math.max(0, provider.maxRetries ?? DEFAULT_MAX_RETRIES);

  /*
   * Claim a process-wide ceiling for this provider, and give it back when the
   * last job using it finishes. Without this, N queued jobs each open
   * `concurrency` requests, which is how a key earns a 429.
   */
  const providerId = providerKey(provider);
  requestLimit(providerId, wanted);

  const batches: WireCue[][] = [];
  for (let start = 0; start < cues.length; start += batchSize) {
    const slice = cues.slice(start, start + batchSize);
    batches.push(slice.map((cue) => ({ i: cue.index, t: cue.text })));
  }

  let completed = 0;
  let requestCount = 0;
  let retryCount = 0;
  let skippedCount = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const batch = batches.shift();
      if (!batch) return;
      if (signal?.aborted) return;

      const expectedIndices = new Set(batch.map((cue) => cue.i));
      let parsed: Map<number, string> | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        if (signal?.aborted) return;
        try {
          requestCount += 1;
          const raw = await withSlot(providerId, () =>
            chatCompletion(provider, [
              { role: "system", content: systemPrompt(targetLang, sourceLang, glossaryLines) },
              { role: "user", content: JSON.stringify(batch) },
            ], signal),
          );
          parsed = parseBatchResponse(raw, expectedIndices);
          break;
        } catch (error) {
          if (attempt === maxRetries) {
            onLog?.("error", `batch starting at cue ${batch[0]?.i ?? "?"} failed: ${describe(error)}`);
            parsed = new Map();
            break;
          }
          retryCount += 1;
          const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
          onLog?.("warn", `batch ${batch[0]?.i ?? "?"} attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`);
          await sleep(backoffMs, signal);
        }
      }

      const result = parsed ?? new Map<number, string>();
      for (const cue of batch) {
        const text = result.get(cue.i);
        if (text === undefined || text.trim() === "") {
          skippedCount += 1;
          continue;
        }
        const position = cues.findIndex((c) => c.index === cue.i);
        if (position >= 0) {
          translations[position] =
            terms.length > 0 ? enforceGlossary(text, terms) : text;
        }
      }

      completed += batch.length;
      onProgress?.(completed, cues.length);
    }
  };

  /*
   * One worker per batch, but every request goes through the limiter, so the
   * number actually in flight is bounded process-wide rather than per job.
   */
  const workers = Array.from(
    { length: Math.min(batches.length, Math.max(1, wanted)) },
    worker,
  );
  try {
    await Promise.all(workers);
  } finally {
    releaseLimit(providerId);
  }

  onProgress?.(cues.length, cues.length);
  return { translations, skippedCount, requestCount, retryCount };
}

/**
 * Validate the model's reply.
 *
 * A well-behaved reply is a bare JSON array. Models frequently add prose, a
 * markdown fence, or wrap the array in an object; all three are recovered.
 * Anything else throws so the caller retries.
 */
export function parseBatchResponse(
  raw: string,
  expectedIndices: ReadonlySet<number>,
): Map<number, string> {
  const candidates = extractJsonCandidates(raw);
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }

    const rows = Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.translations)
        ? value.translations
        : isRecord(value) && Array.isArray(value.items)
          ? value.items
          : undefined;
    if (!rows) continue;

    const map = new Map<number, string>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const index = typeof row.i === "number" ? row.i : undefined;
      const text = typeof row.t === "string" ? row.t : undefined;
      if (index === undefined || text === undefined) continue;
      if (!expectedIndices.has(index)) continue;
      map.set(index, text.trim());
    }
    if (map.size > 0) return map;
  }
  throw new Error("response contained no usable translation entries");
}

/** Possible JSON payloads inside a model reply, most promising first. */
function extractJsonCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const candidates = [withoutFence];
  const firstBracket = withoutFence.indexOf("[");
  const lastBracket = withoutFence.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(withoutFence.slice(firstBracket, lastBracket + 1));
  }
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(withoutFence.slice(firstBrace, lastBrace + 1));
  }
  return candidates;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * One OpenAI-compatible chat completion.
 *
 * Exported because the highlight extractor needs the same primitive without
 * the cue-batching contract.
 */
export async function chatCompletion(
  provider: ProviderConfig,
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${provider.apiKey}`,
    ...provider.headers,
  };

  const body = {
    model: provider.model,
    messages: [...messages],
    temperature: 0.2,
    stream: false,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${endpoint}: ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("provider returned no message content");
  }
  return content;
}

/**
 * Identity of the thing being limited.
 *
 * Two providers with different base URLs or models are separate quotas; two
 * jobs using the same provider share one.
 */
function providerKey(provider: ProviderConfig): string {
  return `${provider.baseUrl.replace(/\/+$/, "")}|${provider.model}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
