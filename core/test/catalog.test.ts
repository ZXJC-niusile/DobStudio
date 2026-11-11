import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clipOutputPath, subtitleFilter } from "../src/clips.ts";
import { DEFAULT_ASS_STYLE, PROVIDER_PRESETS, WHISPER_MODELS, configFromPreset } from "../src/catalog.ts";

describe("subtitleFilter", () => {
  it("uses the ass filter for .ass", () => {
    assert.equal(subtitleFilter("C:/subs/a.ass"), "ass='C\\:/subs/a.ass'");
  });

  it("uses the subtitles filter for .srt", () => {
    assert.equal(subtitleFilter("C:/subs/a.srt"), "subtitles='C\\:/subs/a.srt'");
  });

  it("normalises backslashes", () => {
    assert.equal(subtitleFilter("C:\\subs\\a.srt"), "subtitles='C\\:/subs/a.srt'");
  });

  it("escapes a single quote", () => {
    assert.equal(subtitleFilter("C:/it's/a.srt"), "subtitles='C\\:/it\\'s/a.srt'");
  });

  it("always escapes the drive colon, which is what breaks ffmpeg on Windows", () => {
    assert.ok(subtitleFilter("D:/x.srt").includes("D\\:"));
  });
});

describe("clipOutputPath", () => {
  it("derives a collision-free name from the start time", () => {
    const path = clipOutputPath("C:/out", "C:/in/movie.mp4", 95_000);
    assert.match(path, /movie\.clip-95s\.mp4$/);
  });

  it("keeps the output directory", () => {
    // `join` normalises separators per platform, so compare on the stem.
    const path = clipOutputPath("C:/out", "C:/in/movie.mp4", 0);
    assert.ok(path.replace(/\\/g, "/").startsWith("C:/out/"));
  });
});

describe("catalog", () => {
  it("gives every preset a base URL and a name", () => {
    for (const preset of PROVIDER_PRESETS) {
      assert.ok(preset.baseUrl.startsWith("http"), `${preset.id} baseUrl`);
      assert.ok(preset.name !== "", `${preset.id} name`);
    }
  });

  it("explains any preset that has no default model", () => {
    // Volcengine Ark is the one case: its model names are endpoint ids.
    for (const preset of PROVIDER_PRESETS) {
      if (preset.defaultModel === "") {
        assert.ok(
          preset.notes !== undefined && preset.notes !== "",
          `${preset.id} needs notes when it has no default model`,
        );
      }
    }
  });

  it("has unique preset ids", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("marks local providers as needing no key", () => {
    for (const preset of PROVIDER_PRESETS.filter((p) => p.local)) {
      assert.equal(preset.keyEnv, "", `${preset.id} should not need a key`);
    }
  });

  it("builds a config from a preset", () => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === "deepseek")!;
    const config = configFromPreset(preset, "sk-test");
    assert.equal(config.id, "deepseek");
    assert.equal(config.apiKey, "sk-test");
    assert.equal(config.baseUrl, preset.baseUrl);
    assert.equal(config.model, preset.defaultModel);
  });

  it("substitutes a placeholder key for a local preset", () => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === "ollama")!;
    assert.equal(configFromPreset(preset, "").apiKey, "not-needed");
  });

  it("prefers an explicit model over the preset default", () => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === "openai")!;
    assert.equal(configFromPreset(preset, "k", "gpt-4.1").model, "gpt-4.1");
  });

  it("orders model sizes monotonically up to medium", () => {
    const sizes = (["tiny", "base", "small", "medium"] as const).map(
      (key) => WHISPER_MODELS[key].approxBytes,
    );
    for (let i = 1; i < sizes.length; i += 1) {
      assert.ok(sizes[i]! > sizes[i - 1]!);
    }
  });

  it("keeps the default ASS style within sane bounds", () => {
    assert.ok(DEFAULT_ASS_STYLE.fontSize >= 20 && DEFAULT_ASS_STYLE.fontSize <= 120);
    assert.ok(DEFAULT_ASS_STYLE.outline >= 0 && DEFAULT_ASS_STYLE.outline <= 8);
    assert.ok(DEFAULT_ASS_STYLE.marginV >= 0);
    assert.match(DEFAULT_ASS_STYLE.primaryColor, /^#[0-9A-Fa-f]{6}$/);
    assert.match(DEFAULT_ASS_STYLE.secondaryColor, /^#[0-9A-Fa-f]{6}$/);
  });
});
