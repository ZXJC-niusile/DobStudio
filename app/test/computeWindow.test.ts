import assert from "node:assert/strict";
import { test } from "node:test";
import { computeWindow } from "../src/useVirtualList.ts";

test("visible rows and overscan follow scrolling", () => {
  assert.deepEqual(computeWindow(0, 600, 1200, 76, 8), {
    start: 0,
    end: 16,
    totalHeight: 91200,
    offsetTop: 0,
  });
  assert.deepEqual(computeWindow(7600, 600, 1200, 76, 8), {
    start: 92,
    end: 116,
    totalHeight: 91200,
    offsetTop: 6992,
  });
});

test("short, empty and shortened lists stay within bounds", () => {
  assert.deepEqual(computeWindow(0, 600, 3, 76, 8), {
    start: 0,
    end: 3,
    totalHeight: 228,
    offsetTop: 0,
  });
  assert.deepEqual(computeWindow(7600, 600, 0, 76, 8), {
    start: 0,
    end: 0,
    totalHeight: 0,
    offsetTop: 0,
  });
  assert.deepEqual(computeWindow(7600, 600, 3, 76, 8), {
    start: 2,
    end: 3,
    totalHeight: 228,
    offsetTop: 152,
  });
});
