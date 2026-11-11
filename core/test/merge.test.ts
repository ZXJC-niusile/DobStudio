import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MAX_LINE_CHARS,
  dropOverlaps,
  mergeBilingual,
  splitLongLines,
  summarise,
  toFlatBilingual,
} from "../src/merge.ts";
import type { BilingualCue } from "../src/types.ts";

function cue(index: number, startMs: number, endMs: number, text: string): BilingualCue {
  return { index, startMs, endMs, text };
}

describe("mergeBilingual", () => {
  it("attaches a translation by position", () => {
    const merged = mergeBilingual(
      [
        { index: 1, startMs: 0, endMs: 1000, text: "hello" },
        { index: 2, startMs: 1000, endMs: 2000, text: "world" },
      ],
      ["你好", "世界"],
    );
    assert.equal(merged[0]!.translation, "你好");
    assert.equal(merged[1]!.translation, "世界");
  });

  it("marks blank translations as untranslated rather than empty", () => {
    const merged = mergeBilingual(
      [{ index: 1, startMs: 0, endMs: 1000, text: "hello" }],
      ["   "],
    );
    assert.equal(merged[0]!.translation, undefined);
  });
});

describe("toFlatBilingual", () => {
  it("joins the two lines and renumbers", () => {
    const flat = toFlatBilingual([
      { index: 7, startMs: 0, endMs: 1000, text: "hello", translation: "你好" },
      { index: 9, startMs: 1000, endMs: 2000, text: "world" },
    ]);
    assert.deepEqual(flat.map((c) => c.index), [1, 2]);
    assert.equal(flat[0]!.text, "hello\n你好");
    assert.equal(flat[1]!.text, "world");
  });
});

describe("splitLongLines", () => {
  it("leaves short cues alone", () => {
    const input = [cue(1, 0, 2000, "short line")];
    assert.deepEqual(splitLongLines(input, 42), input);
  });

  it("splits at clause boundaries and keeps the same time span", () => {
    const text =
      "So what we are going to do today is walk through the entire architecture, and then we will look at the performance numbers, and finally we will talk about what comes next.";
    const input = [cue(1, 0, 10_000, text)];
    const out = splitLongLines(input, 42);

    assert.ok(out.length > 1, "expected the cue to be split");
    assert.equal(out[0]!.startMs, 0);
    assert.equal(out[out.length - 1]!.endMs, 10_000);
    for (const piece of out) {
      assert.ok(
        piece.text.length <= 42,
        `piece too long: ${piece.text.length} chars`,
      );
    }
    // Timing must be monotonic and non-degenerate.
    for (let i = 1; i < out.length; i += 1) {
      assert.ok(out[i]!.startMs >= out[i - 1]!.startMs);
      assert.ok(out[i]!.endMs > out[i]!.startMs);
    }
    // No text may be lost.
    assert.equal(
      out.map((p) => p.text).join(" ").replace(/\s+/g, " "),
      text.replace(/\s+/g, " "),
    );
  });

  it("splits the translation instead of repeating it on every piece", () => {
    const input = [
      {
        ...cue(
          1,
          0,
          10_000,
          "So the key idea is gradient descent, and then you take a small step, and repeat until you reach a minimum.",
        ),
        translation:
          "所以核心思想是梯度下降，然后你走一小步，不断重复直到到达极小值，这就是全部的算法了。",
      },
    ];
    const out = splitLongLines(input, 42);

    assert.ok(out.length > 1, "the cue was split");
    // Every piece must carry some translation.
    assert.ok(out.every((p) => p.translation !== undefined && p.translation !== ""));
    // But no piece may repeat the whole sentence: that would make the viewer
    // read the same line twice.
    const whole = input[0]!.translation!;
    assert.ok(
      out.filter((p) => p.translation === whole).length <= 1,
      "the full translation appeared on more than one piece",
    );
    // And the pieces together must still cover the whole translation.
    const joined = out.map((p) => p.translation).join("");
    for (const fragment of ["梯度下降", "一小步", "极小值", "算法"]) {
      assert.ok(joined.includes(fragment), `lost "${fragment}" from the translation`);
    }
    // No piece may be a prefix-repeat of the next one.
    for (let i = 1; i < out.length; i += 1) {
      const previous = out[i - 1]!.translation!;
      const current = out[i]!.translation!;
      const overlap = longestSharedSuffixPrefix(previous, current);
      assert.ok(
        overlap <= Math.max(4, Math.floor(current.length / 3)),
        `pieces ${i - 1} and ${i} overlap by ${overlap} chars: "${previous}" / "${current}"`,
      );
    }
  });

  it("leaves an untranslated cue's pieces untranslated", () => {
    const input = [
      cue(1, 0, 10_000, "a".repeat(30) + ", " + "b".repeat(30) + ", " + "c".repeat(30)),
    ];
    const out = splitLongLines(input, 42);
    assert.ok(out.length > 1);
    assert.ok(out.every((p) => p.translation === undefined));
  });

  it("hard-wraps a single clause with no break characters", () => {
    const input = [cue(1, 0, 5000, "x".repeat(100))];
    const out = splitLongLines(input, 42);
    assert.ok(out.length >= 3);
    assert.equal(out.map((p) => p.text).join(""), "x".repeat(100));
  });

  it("renumbers the result densely", () => {
    const input = [cue(50, 0, 10_000, "a".repeat(30) + ", " + "b".repeat(30))];
    const out = splitLongLines(input, 42);
    assert.deepEqual(out.map((c) => c.index), out.map((_, i) => i + 1));
  });

  it("uses a sane default budget", () => {
    assert.ok(DEFAULT_MAX_LINE_CHARS >= 20 && DEFAULT_MAX_LINE_CHARS <= 60);
  });
});

describe("dropOverlaps", () => {
  it("clamps a cue that starts before the previous one ends", () => {
    const out = dropOverlaps([
      cue(1, 0, 5000, "first"),
      cue(2, 3000, 8000, "second"),
    ]);
    assert.equal(out[1]!.startMs, 5000);
    assert.equal(out.length, 2);
  });

  it("drops cues that end up empty after clamping", () => {
    const out = dropOverlaps([
      cue(1, 0, 5000, "first"),
      cue(2, 4000, 4500, "swallowed"),
    ]);
    assert.equal(out.length, 1);
  });

  it("leaves a clean sequence untouched", () => {
    const input = [cue(1, 0, 1000, "a"), cue(2, 1000, 2000, "b")];
    assert.deepEqual(dropOverlaps(input), input);
  });
});

describe("summarise", () => {
  it("counts translated and untranslated cues", () => {
    const stats = summarise([
      cue(1, 0, 1000, "a"),
      { ...cue(2, 1000, 2000, "b"), translation: "乙" },
    ]);
    assert.deepEqual(stats, {
      cueCount: 2,
      translatedCount: 1,
      untranslatedCount: 1,
    });
  });
});

/** Length of the longest string that is both a suffix of `a` and a prefix of `b`. */
function longestSharedSuffixPrefix(a: string, b: string): number {
  let best = 0;
  for (let len = 1; len <= Math.min(a.length, b.length); len += 1) {
    if (a.endsWith(b.slice(0, len))) best = len;
  }
  return best;
}
