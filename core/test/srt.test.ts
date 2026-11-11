import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatTimestamp,
  mergeByIndex,
  parseSrt,
  parseTimestamp,
  parseVtt,
  reindex,
  serializeSrt,
} from "../src/srt.ts";

const SAMPLE = `1
00:00:01,000 --> 00:00:04,320
And so my fellow Americans

2
00:00:04,320 --> 00:00:07,900
ask not what your country can do for you
ask what you can do for your country
`;

describe("timestamps", () => {
  it("formats milliseconds as SubRip", () => {
    assert.equal(formatTimestamp(0), "00:00:00,000");
    assert.equal(formatTimestamp(1_000), "00:00:01,000");
    assert.equal(formatTimestamp(3_661_500), "01:01:01,500");
  });

  it("formats milliseconds as WebVTT", () => {
    assert.equal(formatTimestamp(3_661_500, "."), "01:01:01.500");
  });

  it("parses both separators", () => {
    assert.equal(parseTimestamp("00:00:01,000"), 1000);
    assert.equal(parseTimestamp("00:00:01.000"), 1000);
    assert.equal(parseTimestamp("01:01:01,500"), 3_661_500);
  });

  it("parses the VTT short form", () => {
    assert.equal(parseTimestamp("04:20.500"), 260_500);
  });

  it("rejects garbage", () => {
    assert.throws(() => parseTimestamp("not-a-time"));
  });
});

describe("parseSrt", () => {
  it("reads indices, timing and multi-line bodies", () => {
    const cues = parseSrt(SAMPLE);
    assert.equal(cues.length, 2);
    assert.equal(cues[0]!.index, 1);
    assert.equal(cues[0]!.startMs, 1000);
    assert.equal(cues[0]!.endMs, 4320);
    assert.equal(cues[0]!.text, "And so my fellow Americans");
    assert.equal(
      cues[1]!.text,
      "ask not what your country can do for you\nask what you can do for your country",
    );
  });

  it("tolerates CRLF and a BOM", () => {
    const crlf = `﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nhello\r\n`;
    const cues = parseSrt(crlf);
    assert.equal(cues.length, 1);
    assert.equal(cues[0]!.text, "hello");
  });

  it("tolerates missing cue indices", () => {
    const noIndex = `00:00:01,000 --> 00:00:02,000\nhello\n`;
    const cues = parseSrt(noIndex);
    assert.equal(cues.length, 1);
    assert.equal(cues[0]!.index, 1);
    assert.equal(cues[0]!.text, "hello");
  });

  it("ignores trailing blank blocks", () => {
    assert.equal(parseSrt(`${SAMPLE}\n\n\n`).length, 2);
  });
});

describe("serializeSrt", () => {
  it("round-trips", () => {
    const cues = parseSrt(SAMPLE);
    assert.deepEqual(parseSrt(serializeSrt(cues)), cues);
  });

  it("ends with exactly one newline", () => {
    const out = serializeSrt(parseSrt(SAMPLE));
    assert.ok(out.endsWith("\n"));
    assert.ok(!out.endsWith("\n\n"));
  });
});

describe("parseVtt", () => {
  it("drops the header, identifiers and inline tags", () => {
    const vtt = `WEBVTT

intro
00:00:01.000 --> 00:00:02.000
<v Speaker>Hello <i>there</i>

00:00:02.000 --> 00:00:03.000
plain
`;
    const cues = parseVtt(vtt);
    assert.equal(cues.length, 2);
    // The <v Speaker> tag is an inline element whose *content* is "Hello";
    // "Speaker" is an attribute, so it must not leak into the text.
    assert.equal(cues[0]!.text, "Hello there");
    assert.equal(cues[1]!.text, "plain");
  });

  it("falls back to SRT rules for a non-VTT file", () => {
    const cues = parseVtt(SAMPLE);
    assert.equal(cues.length, 2);
  });
});

describe("mergeByIndex", () => {
  it("joins source and translation with a newline", () => {
    const originals = parseSrt(SAMPLE);
    const merged = mergeByIndex(originals, ["第一个", "第二个"]);
    assert.equal(merged[0]!.text, "And so my fellow Americans\n第一个");
    assert.equal(merged[1]!.text.includes("第二个"), true);
  });

  it("leaves the cue untouched when a translation is missing", () => {
    const originals = parseSrt(SAMPLE);
    const merged = mergeByIndex(originals, ["第一个"]);
    assert.equal(merged[1]!.text, originals[1]!.text);
  });
});

describe("reindex", () => {
  it("makes indices dense and 1-based", () => {
    const sparse = parseSrt(SAMPLE).map((c, i) => ({ ...c, index: i + 100 }));
    assert.deepEqual(reindex(sparse).map((c) => c.index), [1, 2]);
  });
});
