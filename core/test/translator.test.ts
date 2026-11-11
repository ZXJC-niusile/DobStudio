import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseBatchResponse } from "../src/translator.ts";

const EXPECTED = new Set([1, 2, 3]);

describe("parseBatchResponse", () => {
  it("accepts a bare JSON array", () => {
    const map = parseBatchResponse(
      '[{"i":1,"t":"一"},{"i":2,"t":"二"},{"i":3,"t":"三"}]',
      EXPECTED,
    );
    assert.equal(map.get(1), "一");
    assert.equal(map.size, 3);
  });

  it("strips a markdown code fence", () => {
    const map = parseBatchResponse(
      '```json\n[{"i":1,"t":"一"}]\n```',
      EXPECTED,
    );
    assert.equal(map.get(1), "一");
  });

  it("recovers an array buried in prose", () => {
    const map = parseBatchResponse(
      'Sure! Here you go:\n[{"i":2,"t":"二"}]\nHope that helps.',
      EXPECTED,
    );
    assert.equal(map.get(2), "二");
  });

  it("accepts an object wrapper", () => {
    const map = parseBatchResponse(
      '{"translations":[{"i":3,"t":"三"}]}',
      EXPECTED,
    );
    assert.equal(map.get(3), "三");
  });

  it("accepts an items wrapper", () => {
    const map = parseBatchResponse('{"items":[{"i":1,"t":"一"}]}', EXPECTED);
    assert.equal(map.get(1), "一");
  });

  it("drops rows whose index was not in the batch", () => {
    const map = parseBatchResponse(
      '[{"i":1,"t":"一"},{"i":99,"t":"hallucinated"}]',
      EXPECTED,
    );
    assert.equal(map.size, 1);
    assert.equal(map.get(99), undefined);
  });

  it("ignores rows missing the translation field", () => {
    const map = parseBatchResponse('[{"i":1},{"i":2,"t":"二"}]', EXPECTED);
    assert.equal(map.size, 1);
    assert.equal(map.get(2), "二");
  });

  it("throws when nothing usable came back", () => {
    assert.throws(() => parseBatchResponse("I refuse to translate this.", EXPECTED));
    assert.throws(() => parseBatchResponse("[]", EXPECTED));
    assert.throws(() => parseBatchResponse("[not json", EXPECTED));
  });

  it("trims whitespace from translations", () => {
    const map = parseBatchResponse('[{"i":1,"t":"  一  "}]', EXPECTED);
    assert.equal(map.get(1), "一");
  });
});
