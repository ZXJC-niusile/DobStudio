import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseHighlights } from "../src/highlights.ts";
import type { Cue } from "../src/types.ts";

const ALLOWED = new Set([1, 2, 3, 4, 5]);

function cue(index: number, startMs: number, endMs: number): Cue {
  return { index, startMs, endMs, text: `line ${index}` };
}

/** Resolve wire spans against a cue table, mirroring the module's own logic. */
function resolve(
  rows: { from: number; to: number; title: string; reason: string }[],
  cues: Cue[],
): { startMs: number; endMs: number }[] {
  const byIndex = new Map(cues.map((c) => [c.index, c]));
  return rows.flatMap((row) => {
    const first = byIndex.get(row.from);
    const last = byIndex.get(row.to);
    if (!first || !last) return [];
    if (last.endMs <= first.startMs) return [];
    return [{ startMs: first.startMs, endMs: last.endMs }];
  });
}

describe("parseHighlights", () => {
  it("accepts a bare JSON array", () => {
    const rows = parseHighlights(
      '[{"from":1,"to":2,"title":"Intro","reason":"Sets up the problem"}]',
      ALLOWED,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.from, 1);
    assert.equal(rows[0]!.to, 2);
    assert.equal(rows[0]!.title, "Intro");
  });

  it("strips a markdown fence and surrounding prose", () => {
    const rows = parseHighlights(
      'Here are the highlights:\n```json\n[{"from":3,"to":4,"title":"X"}]\n```\nDone.',
      ALLOWED,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.from, 3);
  });

  it("accepts an object wrapper", () => {
    const rows = parseHighlights(
      '{"highlights":[{"from":1,"to":1,"title":"Solo"}]}',
      ALLOWED,
    );
    assert.equal(rows.length, 1);
  });

  it("rejects indices that are not in this batch", () => {
    const rows = parseHighlights(
      '[{"from":1,"to":99,"title":"Out of range"}]',
      ALLOWED,
    );
    assert.equal(rows.length, 0);
  });

  it("rejects an inverted range", () => {
    const rows = parseHighlights(
      '[{"from":4,"to":2,"title":"Backwards"}]',
      ALLOWED,
    );
    assert.equal(rows.length, 0);
  });

  it("rejects a missing title", () => {
    const rows = parseHighlights('[{"from":1,"to":2,"reason":"no title"}]', ALLOWED);
    assert.equal(rows.length, 0);
  });

  it("returns nothing for unusable output", () => {
    assert.deepEqual(parseHighlights("I cannot help with that.", ALLOWED), []);
    assert.deepEqual(parseHighlights("[]", ALLOWED), []);
    assert.deepEqual(parseHighlights("[broken", ALLOWED), []);
  });
});

describe("highlight span resolution", () => {
  const cues = [cue(1, 0, 1000), cue(2, 1000, 2000), cue(3, 2000, 3000)];

  it("maps a cue range onto its time span", () => {
    const spans = resolve([{ from: 1, to: 3, title: "t", reason: "r" }], cues);
    assert.deepEqual(spans, [{ startMs: 0, endMs: 3000 }]);
  });

  it("drops a zero-length span", () => {
    const spans = resolve([{ from: 2, to: 2, title: "t", reason: "r" }], cues);
    assert.deepEqual(spans, [{ startMs: 1000, endMs: 2000 }]);
  });

  it("ignores an index that does not exist", () => {
    const spans = resolve([{ from: 1, to: 42, title: "t", reason: "r" }], cues);
    assert.deepEqual(spans, []);
  });
});
