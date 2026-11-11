/**
 * SubRip / WebVTT parsing and serialisation.
 *
 * Everything downstream of the ASR and translation layers speaks `Cue`, so the
 * parsers are the single place where timecode formats are understood.
 */

import type { Cue } from "./types.ts";

const SRT_TIME = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;
const VTT_SHORT_TIME = /^(\d{1,2}):(\d{2})\.(\d{1,3})$/;

/** Format milliseconds as `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT). */
export function formatTimestamp(
  ms: number,
  msSeparator: "," | "." = ",",
): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${msSeparator}${pad(millis, 3)}`;
}

/** Parse `HH:MM:SS,mmm`, `HH:MM:SS.mmm` or the VTT short form `MM:SS.mmm`. */
export function parseTimestamp(raw: string): number {
  const text = raw.trim();
  const full = SRT_TIME.exec(text);
  if (full) {
    const [, h, m, s, ms] = full;
    return (
      Number(h) * 3_600_000 +
      Number(m) * 60_000 +
      Number(s) * 1000 +
      Number(ms!.padEnd(3, "0"))
    );
  }
  const short = VTT_SHORT_TIME.exec(text);
  if (short) {
    const [, m, s, ms] = short;
    return (
      Number(m) * 60_000 + Number(s) * 1000 + Number(ms!.padEnd(3, "0"))
    );
  }
  throw new Error(`Unrecognised timestamp: ${JSON.stringify(raw)}`);
}

/** Strip a UTF-8 BOM and normalise line endings. */
function normalise(input: string): string {
  return input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function splitBlocks(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

/**
 * Parse SubRip. Tolerates missing cue indices, blank-ish blocks and trailing
 * whitespace, all of which show up in the wild.
 */
export function parseSrt(input: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of splitBlocks(normalise(input))) {
    const lines = block.split("\n");
    let cursor = 0;

    // Optional numeric index line.
    if (lines[cursor] !== undefined && /^\d+$/.test(lines[cursor]!.trim())) {
      cursor += 1;
    }

    const timingLine = lines[cursor];
    if (timingLine === undefined) continue;
    const timing = /^(.*?)\s*-->\s*(.*?)(?:\s+.*)?$/.exec(timingLine.trim());
    if (!timing) continue;

    const startMs = parseTimestamp(timing[1]!);
    const endMs = parseTimestamp(timing[2]!);
    const text = lines
      .slice(cursor + 1)
      .join("\n")
      .trim();

    cues.push({ index: cues.length + 1, startMs, endMs, text });
  }
  return cues;
}

/** Parse WebVTT, dropping the header, NOTE blocks and cue identifiers. */
export function parseVtt(input: string): Cue[] {
  const cues: Cue[] = [];
  const text = normalise(input);
  if (!/^WEBVTT/.test(text)) {
    // Not a real VTT file — fall back to SRT rules rather than failing.
    return parseSrt(input);
  }
  for (const block of splitBlocks(text)) {
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(block)) continue;
    const lines = block.split("\n");
    let cursor = 0;

    // VTT may carry an optional cue identifier before the timing line.
    if (lines[cursor] !== undefined && !lines[cursor]!.includes("-->")) {
      cursor += 1;
    }
    const timingLine = lines[cursor];
    if (timingLine === undefined || !timingLine.includes("-->")) continue;

    const timing = /^(.*?)\s*-->\s*(.*?)(?:\s+.*)?$/.exec(timingLine.trim());
    if (!timing) continue;

    const body = lines
      .slice(cursor + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "") // strip <v Speaker>, <i>, <b>, …
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .trim();

    cues.push({
      index: cues.length + 1,
      startMs: parseTimestamp(timing[1]!),
      endMs: parseTimestamp(timing[2]!),
      text: body,
    });
  }
  return cues;
}

/** Serialise cues as SubRip. */
export function serializeSrt(cues: readonly Cue[]): string {
  return `${cues
    .map((cue) => {
      return [
        String(cue.index),
        `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`,
        cue.text,
      ].join("\n");
    })
    .join("\n\n")}\n`;
}

/** Serialise cues as WebVTT. */
export function serializeVtt(cues: readonly Cue[]): string {
  const body = cues
    .map((cue) => {
      return [
        String(cue.index),
        `${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}`,
        cue.text,
      ].join("\n");
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

/**
 * Merge an original-language cue list with translations by index.
 *
 * The translator is contractually forbidden from reordering, splitting or
 * dropping entries, so index alignment is safe. Anything the model failed to
 * return simply has no `translation`.
 */
export function mergeByIndex(
  originals: readonly Cue[],
  translations: readonly string[],
): Cue[] {
  return originals.map((cue, i) => {
    const translation = translations[i];
    return translation === undefined || translation === ""
      ? cue
      : { ...cue, text: `${cue.text}\n${translation}` };
  });
}

/** Re-index cues so `index` is dense and 1-based. */
export function reindex(cues: readonly Cue[]): Cue[] {
  return cues.map((cue, i) => ({ ...cue, index: i + 1 }));
}
