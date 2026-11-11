/**
 * Terminology consistency.
 *
 * A single LLM request will happily translate a proper noun three different
 * ways across one video. Two mechanisms keep it stable:
 *
 *  1. The glossary is injected into the translation prompt as a hard mapping.
 *  2. `enforce` optionally rewrites the model's output back to the mapping,
 *     which catches the cases where the prompt instruction was ignored.
 *
 * Neither mechanism is applied to the source text, only to translations.
 */

import type { GlossaryEntry } from "./types.ts";

export interface CompiledTerm {
  pattern: RegExp;
  target: string;
  original: string;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glossary into word-boundary-anchored patterns.
 *
 * Terms containing spaces or CJK characters are matched without word
 * boundaries, since `\b` is meaningless around Han script.
 */
export function compileGlossary(entries: readonly GlossaryEntry[]): CompiledTerm[] {
  const compiled: CompiledTerm[] = [];
  for (const entry of entries) {
    const source = entry.source.trim();
    const target = entry.target.trim();
    if (source === "" || target === "") continue;

    const needsBoundary = /^[\w\s'-]+$/.test(source) && !/[一-鿿]/.test(source);
    const body = needsBoundary
      ? `\\b${escapeRegExp(source)}\\b`
      : escapeRegExp(source);

    compiled.push({
      original: source,
      target,
      pattern: new RegExp(body, entry.caseInsensitive ? "gi" : "g"),
    });
  }
  // Longest source first so " gradient descent " wins over " descent ".
  return compiled.sort((a, b) => b.original.length - a.original.length);
}

/** Render the glossary as prompt instructions for the translator. */
export function glossaryPromptLines(entries: readonly GlossaryEntry[]): string[] {
  return entries
    .filter((entry) => entry.source.trim() !== "" && entry.target.trim() !== "")
    .map((entry) => `- "${entry.source.trim()}" → "${entry.target.trim()}"`);
}

/**
 * Rewrite a translation so every occurrence of a glossary source term uses the
 * mandated target term.
 */
export function enforceGlossary(
  translation: string,
  terms: readonly CompiledTerm[],
): string {
  let out = translation;
  for (const term of terms) {
    out = out.replace(term.pattern, term.target);
  }
  return out;
}
