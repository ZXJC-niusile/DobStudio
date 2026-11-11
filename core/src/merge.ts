/**
 * Bilingual assembly and display-line splitting.
 *
 * Two transforms live here because they are the only places that change cue
 * timing rather than cue text:
 *
 *  - `mergeBilingual` pairs each source cue with its translation.
 *  - `splitLongLines` breaks one over-long cue into several readable ones,
 *    re-deriving each sub-cue's duration from its share of the characters.
 */

import type { BilingualCue, Cue } from "./types.ts";

/** Pair source cues with translations by position. */
export function mergeBilingual(
  originals: readonly Cue[],
  translations: readonly string[],
): BilingualCue[] {
  return originals.map((cue, i) => {
    const translation = translations[i];
    return {
      ...cue,
      translation:
        translation !== undefined && translation.trim() !== ""
          ? translation.trim()
          : undefined,
    };
  });
}

/** Flatten bilingual cues back to plain `source\ntranslation` cues. */
export function toFlatBilingual(cues: readonly BilingualCue[]): Cue[] {
  return cues.map((cue, i) => ({
    index: i + 1,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text:
      cue.translation === undefined
        ? cue.text
        : `${cue.text}\n${cue.translation}`,
  }));
}

/** Characters per display line before a cue is considered too long. */
export const DEFAULT_MAX_LINE_CHARS = 42;

/**
 * Split cues whose combined display width exceeds `maxChars`.
 *
 * Splitting happens at clause boundaries (`,`, `,`, `、`, `;`, `:`, `。`, `.`,
 * `!`, `?`, `—`). Timing is divided proportionally to character count, which
 * reads correctly because speech rate is roughly uniform within a single cue.
 *
 * The translation is split the same way, at the same character ratios. Copying
 * the whole translation onto every piece — the obvious implementation — makes
 * the viewer read the same sentence twice, which is worse than a slightly
 * imprecise boundary.
 */
export function splitLongLines(
  cues: readonly BilingualCue[],
  maxChars: number = DEFAULT_MAX_LINE_CHARS,
): BilingualCue[] {
  const out: BilingualCue[] = [];
  for (const cue of cues) {
    const pieces = splitText(cue.text, maxChars);
    if (pieces.length <= 1) {
      out.push(cue);
      continue;
    }

    const totalChars = pieces.reduce((sum, p) => sum + p.length, 0);
    const span = Math.max(1, cue.endMs - cue.startMs);
    let cursor = cue.startMs;

    pieces.forEach((piece, i) => {
      const share =
        i === pieces.length - 1
          ? cue.endMs - cursor
          : Math.round((piece.length / totalChars) * span);
      const end =
        i === pieces.length - 1 ? cue.endMs : Math.min(cue.endMs, cursor + share);

      out.push({
        index: 0,
        startMs: cursor,
        endMs: Math.max(cursor + 120, end),
        text: piece,
        translation: pickTranslation(cue.translation, i, pieces.length),
      });
      cursor = end;
    });
  }
  return renumber(out);
}

/**
 * Translation slice for piece `index` of `total`.
 *
 * The translation is divided by the same fractions the source was. Slicing is
 * by character position rather than by clause, because a translation often has
 * no clause boundaries at all — a single long Chinese sentence, say — and
 * clause-indexing it would hand the same full sentence to every piece.
 *
 * Boundaries snap to a nearby space when there is one, so English words are not
 * cut in half; CJK text, which has no spaces, is simply divided.
 */
function pickTranslation(
  translation: string | undefined,
  index: number,
  total: number,
): string | undefined {
  if (translation === undefined) return undefined;
  if (total <= 1) return translation;

  const rawFrom = Math.floor((index / total) * translation.length);
  const rawTo =
    index === total - 1
      ? translation.length
      : Math.max(
          rawFrom + 1,
          Math.floor(((index + 1) / total) * translation.length),
        );

  const from = index === 0 ? 0 : snapForward(translation, rawFrom);
  const to = index === total - 1 ? translation.length : snapBackward(translation, rawTo);

  const slice = translation.slice(from, to).trim();
  return slice === "" ? undefined : slice;
}

/** Move a cut point forward to just after the nearest preceding space. */
function snapForward(text: string, at: number): number {
  const space = text.lastIndexOf(" ", at);
  return space > 0 && at - space <= 12 ? space + 1 : at;
}

/** Move a cut point back to the nearest following space. */
function snapBackward(text: string, at: number): number {
  const space = text.indexOf(" ", at);
  return space > 0 && space - at <= 12 ? space : at;
}

const CLAUSE_BREAK = /(?<=[,，、;；:：。.！!？?—…])\s*/;

function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text
    .split(CLAUSE_BREAK)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // A single over-long clause still gets wrapped below; only an empty split
  // would make the packing loop meaningless.
  if (sentences.length === 0) return [text];

  // Greedily pack clauses into lines that fit.
  const lines: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current === "") {
      current = sentence;
    } else if (current.length + sentence.length + 1 <= maxChars) {
      current = `${current} ${sentence}`;
    } else {
      lines.push(current);
      current = sentence;
    }
  }
  if (current !== "") lines.push(current);

  // A single clause longer than the budget still has to be shown; wrap it at
  // word boundaries, breaking a word only when the word alone is too long.
  const wrapped: string[] = [];
  for (const line of lines) {
    wrapped.push(...wrapWords(line, maxChars));
  }
  return wrapped.length > 0 ? wrapped : [text];
}

/** Wrap at word boundaries, falling back to a hard break for long words. */
function wrapWords(line: string, maxChars: number): string[] {
  const words = line.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [line];

  const packed: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      packed.push(current);
      current = word;
    }
  }
  if (current !== "") packed.push(current);

  const out: string[] = [];
  for (const chunk of packed) {
    if (chunk.length <= maxChars) {
      out.push(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length; i += maxChars) {
      out.push(chunk.slice(i, i + maxChars));
    }
  }
  return out;
}

/** Re-index cues so `index` is dense and 1-based. */
export function renumber(cues: readonly Cue[]): Cue[] {
  return cues.map((cue, i) => ({ ...cue, index: i + 1 }));
}

/** Drop cues that overlap the previous one's end (ASR artefacts). */
export function dropOverlaps(cues: readonly BilingualCue[]): BilingualCue[] {
  const out: BilingualCue[] = [];
  for (const cue of cues) {
    const previous = out[out.length - 1];
    if (previous && cue.startMs < previous.endMs) {
      out.push({ ...cue, startMs: previous.endMs });
    } else {
      out.push(cue);
    }
  }
  return out.filter((cue) => cue.endMs > cue.startMs);
}

/** Basic sanity stats for a finished job. */
export function summarise(cues: readonly BilingualCue[]): {
  cueCount: number;
  translatedCount: number;
  untranslatedCount: number;
} {
  return {
    cueCount: cues.length,
    translatedCount: cues.filter((c) => c.translation !== undefined).length,
    untranslatedCount: cues.filter((c) => c.translation === undefined).length,
  };
}
