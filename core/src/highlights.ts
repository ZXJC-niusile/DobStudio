/**
 * Highlight extraction.
 *
 * Given a transcript, ask the model which spans are worth watching and why.
 * This is the feature the reference product describes as "AI picks the
 * noteworthy passages, each with a title and a reason" — and it is a plain
 * summarisation task over the cue list, so it shares the translator's
 * batching, concurrency and retry machinery.
 *
 * The model works in *cue indices*, never in timestamps. LLMs are unreliable
 * at arithmetic on timecodes and reliable at referring to list positions, so
 * the indices are resolved back to milliseconds here, where it is checkable.
 */

import type { Cue, Highlight, Lang, ProviderConfig } from "./types.ts";
import { chatCompletion } from "./translator.ts";

export interface HighlightOptions {
  provider: ProviderConfig;
  /** Language for the titles and reasons. Defaults to the target language. */
  outputLang?: Lang;
  /** How many highlights to ask for. Default 8. */
  maxHighlights?: number;
  /** Cues per request. Default 60. */
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

interface WireHighlight {
  from: number;
  to: number;
  title: string;
  reason: string;
}

const SYSTEM_PROMPT = [
  "You select the most noteworthy spans of a video from its subtitle cues.",
  "",
  "Rules — follow every one:",
  "1. Reply with a JSON array only. No prose, no markdown code fence.",
  '2. Each element is exactly {"from": <first cue index>, "to": <last cue index>, "title": "<short label>", "reason": "<one sentence>"}.',
  "3. `from` and `to` must be cue indices that exist in the input, and from <= to.",
  "4. Spans must not overlap each other.",
  "5. Order spans by how strongly they are worth watching, best first.",
  "6. Titles are at most 12 words. Reasons are one sentence.",
  "7. Prefer self-contained moments: a conclusion, a demonstration, a surprising claim, a concrete number.",
].join("\n");

export async function extractHighlights(
  cues: readonly Cue[],
  options: HighlightOptions,
): Promise<Highlight[]> {
  const {
    provider,
    outputLang,
    maxHighlights = 8,
    batchSize = 60,
    signal,
    onProgress,
  } = options;

  if (cues.length === 0) return [];

  const indexOfCue = new Map<number, Cue>();
  for (const cue of cues) indexOfCue.set(cue.index, cue);

  const batches: { i: number; t: string }[][] = [];
  for (let start = 0; start < cues.length; start += batchSize) {
    batches.push(
      cues.slice(start, start + batchSize).map((cue) => ({ i: cue.index, t: cue.text })),
    );
  }

  let completed = 0;
  const collected: WireHighlight[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const batch = batches.shift();
      if (!batch) return;
      if (signal?.aborted) return;

      const allowed = new Set(batch.map((cue) => cue.i));
      const prompt = [
        `Select up to ${maxHighlights} highlights from these cues.`,
        outputLang !== undefined
          ? `Write the titles and reasons in ${outputLang}.`
          : "",
        "",
        JSON.stringify(batch),
      ]
        .filter((line) => line !== "")
        .join("\n");

      try {
        const raw = await chatCompletion(
          provider,
          [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          signal,
        );
        collected.push(...parseHighlights(raw, allowed));
      } catch {
        // A failed highlight batch degrades the feature, not the job.
      }

      completed += batch.length;
      onProgress?.(completed, cues.length);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, provider.concurrency ?? 4), batches.length) },
      worker,
    ),
  );

  return resolveHighlights(collected, indexOfCue, maxHighlights);
}

/**
 * Validate the model's highlight reply.
 *
 * Returns only the rows that reference cue indices actually present in this
 * batch, which is what makes the subsequent timestamp resolution safe.
 */
export function parseHighlights(
  raw: string,
  allowedIndices: ReadonlySet<number>,
): WireHighlight[] {
  const out: WireHighlight[] = [];
  for (const candidate of jsonCandidates(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const rows = Array.isArray(value)
      ? value
      : isRecord(value) && Array.isArray(value.highlights)
        ? value.highlights
        : isRecord(value) && Array.isArray(value.items)
          ? value.items
          : undefined;
    if (!rows) continue;

    for (const row of rows) {
      if (!isRecord(row)) continue;
      const from = typeof row.from === "number" ? Math.trunc(row.from) : undefined;
      const to = typeof row.to === "number" ? Math.trunc(row.to) : undefined;
      const title = typeof row.title === "string" ? row.title.trim() : "";
      const reason = typeof row.reason === "string" ? row.reason.trim() : "";
      if (from === undefined || to === undefined) continue;
      if (to < from) continue;
      if (!allowedIndices.has(from) || !allowedIndices.has(to)) continue;
      if (title === "") continue;
      out.push({ from, to, title, reason });
    }
    if (out.length > 0) return out;
  }
  return out;
}

/**
 * Turn cue-index spans into millisecond ranges.
 *
 * Overlapping spans are dropped rather than merged: the model occasionally
 * returns the same moment twice from different batches, and two overlapping
 * highlights on a progress bar are worse than one fewer highlight.
 */
function resolveHighlights(
  rows: readonly WireHighlight[],
  indexOfCue: ReadonlyMap<number, Cue>,
  limit: number,
): Highlight[] {
  const resolved: Highlight[] = [];
  for (const row of rows) {
    const first = indexOfCue.get(row.from);
    const last = indexOfCue.get(row.to);
    if (!first || !last) continue;
    if (last.endMs <= first.startMs) continue;
    resolved.push({
      startMs: first.startMs,
      endMs: last.endMs,
      title: row.title,
      reason: row.reason,
      fromCue: row.from,
      toCue: row.to,
    });
  }

  resolved.sort((a, b) => a.startMs - b.startMs);

  const kept: Highlight[] = [];
  for (const candidate of resolved) {
    const previous = kept[kept.length - 1];
    if (previous && candidate.startMs < previous.endMs) continue;
    kept.push(candidate);
    if (kept.length >= limit) break;
  }
  return kept;
}

function jsonCandidates(raw: string): string[] {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const out = [trimmed];
  const first = trimmed.indexOf("[");
  const last = trimmed.lastIndexOf("]");
  if (first >= 0 && last > first) out.push(trimmed.slice(first, last + 1));
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    out.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
