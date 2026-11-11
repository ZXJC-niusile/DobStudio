import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  escapeAssText,
  formatAssTime,
  renderAss,
  toAssColor,
} from "../src/ass.ts";
import { DEFAULT_ASS_STYLE } from "../src/catalog.ts";
import {
  compileGlossary,
  enforceGlossary,
  glossaryPromptLines,
} from "../src/glossary.ts";

describe("toAssColor", () => {
  it("converts #RRGGBB to &HAABBGGRR", () => {
    assert.equal(toAssColor("#FF0000"), "&H000000FF");
    assert.equal(toAssColor("#00FF00"), "&H0000FF00");
    assert.equal(toAssColor("#0000FF"), "&H00FF0000");
    assert.equal(toAssColor("#FFFFFF"), "&H00FFFFFF");
  });

  it("expands three-digit hex", () => {
    assert.equal(toAssColor("#F00"), "&H000000FF");
  });

  it("applies an alpha channel", () => {
    assert.equal(toAssColor("#000000", 128), "&H80000000");
  });
});

describe("formatAssTime", () => {
  it("uses centiseconds", () => {
    assert.equal(formatAssTime(0), "0:00:00.00");
    assert.equal(formatAssTime(1000), "0:00:01.00");
    assert.equal(formatAssTime(3_661_500), "1:01:01.50");
  });
});

describe("escapeAssText", () => {
  it("escapes override braces", () => {
    assert.equal(escapeAssText("a {b} c"), "a \\{b\\} c");
  });

  it("turns newlines into \\N", () => {
    assert.equal(escapeAssText("a\nb"), "a\\Nb");
  });
});

describe("renderAss", () => {
  it("emits the three required sections", () => {
    const out = renderAss([
      { index: 1, startMs: 1000, endMs: 3000, text: "hello", translation: "你好" },
    ]);
    assert.ok(out.includes("[Script Info]"));
    assert.ok(out.includes("[V4+ Styles]"));
    assert.ok(out.includes("[Events]"));
  });

  it("writes one dialogue per cue with both lines", () => {
    const out = renderAss([
      { index: 1, startMs: 1000, endMs: 3000, text: "hello", translation: "你好" },
    ]);
    assert.ok(out.includes("Dialogue: 0,0:00:01.00,0:00:03.00,Src,,0,0,0,,hello\\N"));
  });

  it("omits the translation line when there is none", () => {
    const out = renderAss([
      { index: 1, startMs: 0, endMs: 1000, text: "hello" },
    ]);
    const dialogue = out.split("\n").find((l) => l.startsWith("Dialogue:"))!;
    assert.ok(dialogue.endsWith("hello"));
    assert.ok(!dialogue.includes("\\N"));
  });

  it("honours style overrides", () => {
    const out = renderAss(
      [{ index: 1, startMs: 0, endMs: 1000, text: "x", translation: "y" }],
      { style: { primaryColor: "#123456", fontSize: 40 } },
    );
    assert.ok(out.includes("&H00563412")); // B=56 G=34 R=12
    assert.ok(out.includes("40,")); // the source style's font size
  });

  it("keeps the default style usable", () => {
    assert.ok(DEFAULT_ASS_STYLE.fontSize > 0);
    assert.ok(DEFAULT_ASS_STYLE.marginV >= 0);
  });
});

describe("glossary", () => {
  it("compiles word-bounded terms", () => {
    const [term] = compileGlossary([{ source: "gradient", target: "梯度" }]);
    assert.ok(term);
    assert.equal(enforceGlossary("the gradient descent step", [term]), "the 梯度 descent step");
  });

  it("does not match a term inside a longer word", () => {
    const [term] = compileGlossary([{ source: "grad", target: "梯度" }]);
    assert.equal(enforceGlossary("gradient", [term]), "gradient");
  });

  it("matches CJK terms without word boundaries", () => {
    const [term] = compileGlossary([{ source: "大语言模型", target: "LLM" }]);
    assert.equal(enforceGlossary("这是大语言模型的 demo", [term]), "这是LLM的 demo");
  });

  it("applies the longest term first", () => {
    const terms = compileGlossary([
      { source: "descent", target: "下降" },
      { source: "gradient descent", target: "梯度下降" },
    ]);
    assert.equal(enforceGlossary("gradient descent", terms), "梯度下降");
  });

  it("supports case-insensitive matching", () => {
    const [term] = compileGlossary([
      { source: "OpenAI", target: "OpenAI", caseInsensitive: true },
    ]);
    assert.equal(enforceGlossary("openai and OPENAI", [term]), "OpenAI and OpenAI");
  });

  it("renders prompt lines and skips empty entries", () => {
    const lines = glossaryPromptLines([
      { source: "agent", target: "智能体" },
      { source: "  ", target: "ignored" },
      { source: "x", target: "" },
    ]);
    assert.deepEqual(lines, ['- "agent" → "智能体"']);
  });
});
