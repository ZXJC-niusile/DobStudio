/**
 * Virtual-list arithmetic.
 *
 * `computeWindow` is the whole behaviour that matters — which rows are on
 * screen, and where the rendered slice has to be pushed to land correctly. The
 * hook around it only reads scroll geometry and subscribes to events, which is
 * the part that needs a browser and is covered by the GUI smoke test.
 *
 * The invariants asserted here are the ones that, if broken, would silently
 * show the wrong cues rather than fail loudly.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeWindow } from "../src/useVirtualList.ts";

const ROW = 76;

describe("computeWindow", () => {
  it("starts at the top with no scroll", () => {
    const w = computeWindow(0, 600, 1200, ROW, 8);
    assert.equal(w.start, 0);
    assert.equal(w.offsetTop, 0);
    assert.equal(w.totalHeight, 1200 * ROW);
  });

  it("covers the viewport plus overscan on both sides", () => {
    const w = computeWindow(0, 600, 1200, ROW, 8);
    // 8 visible rows (600/76 = 7.9 → 8), plus 8 overscan below.
    assert.equal(w.end, 16);
    assert.ok(w.end - w.start >= Math.ceil(600 / ROW));
  });

  it("advances the window as the user scrolls", () => {
    const w = computeWindow(7600, 600, 1200, ROW, 8);
    assert.equal(w.start, 92, "row 100 is at the top, minus 8 overscan");
    assert.ok(w.end > w.start);
  });

  it("clamps to the end of the list", () => {
    const w = computeWindow(1_000_000, 600, 1200, ROW, 8);
    assert.equal(w.end, 1200, "never renders rows past the end");
    assert.ok(w.start < 1200);
  });

  it("never underflows when overscan exceeds the list", () => {
    const w = computeWindow(0, 600, 3, ROW, 50);
    assert.equal(w.start, 0);
    assert.equal(w.end, 3, "all three rows, no phantom rows");
    assert.equal(w.totalHeight, 3 * ROW);
  });

  it("survives a negative scroll position", () => {
    const w = computeWindow(-500, 600, 1200, ROW, 8);
    assert.equal(
      w.start,
      0,
      "rubber-band scrolling must not produce a negative row",
    );
    assert.ok(w.end > 0);
  });

  it("survives a zero-height viewport", () => {
    // Happens before first layout, when the container reports no height.
    const w = computeWindow(0, 0, 1200, ROW, 8);
    assert.ok(
      w.end - w.start >= 1,
      "at least one row, or nothing ever renders",
    );
    assert.equal(w.totalHeight, 1200 * ROW);
  });

  it("keeps offsetTop aligned with the first rendered row", () => {
    for (const scrollTop of [0, 1, 500, 7600, 30_000, 91_200]) {
      const w = computeWindow(scrollTop, 600, 1200, ROW, 8);
      assert.equal(
        w.offsetTop,
        w.start * ROW,
        `row ${w.start} must land exactly where it belongs at scrollTop ${scrollTop}`,
      );
    }
  });

  it("keeps the scrollbar truthful", () => {
    assert.equal(computeWindow(0, 600, 1200, ROW, 8).totalHeight, 91_200);
    assert.equal(computeWindow(0, 600, 0, ROW, 8).totalHeight, 0);
  });

  it("is monotonic while scrolling down", () => {
    let previous = -1;
    for (let scrollTop = 0; scrollTop <= 100_000; scrollTop += 137) {
      const w = computeWindow(scrollTop, 600, 1200, ROW, 8);
      assert.ok(w.start >= previous, `start went backwards at ${scrollTop}`);
      assert.ok(w.end >= w.start, `end before start at ${scrollTop}`);
      previous = w.start;
    }
  });

  it("always renders at least a viewport of rows when the list allows", () => {
    for (const scrollTop of [0, 3000, 20_000, 80_000]) {
      const w = computeWindow(scrollTop, 600, 1200, ROW, 8);
      assert.ok(
        w.end - w.start >= Math.ceil(600 / ROW),
        `viewport uncovered at ${scrollTop}: ${w.end - w.start} rows`,
      );
    }
  });

  it("handles a list shorter than one viewport", () => {
    const w = computeWindow(0, 600, 3, ROW, 8);
    assert.equal(w.start, 0);
    assert.equal(w.end, 3);
  });

  it("handles an empty list", () => {
    const w = computeWindow(0, 600, 0, ROW, 8);
    assert.equal(w.start, 0);
    assert.equal(w.end, 0);
    assert.equal(w.totalHeight, 0);
    assert.equal(w.offsetTop, 0);
  });

  it("reports the overscan it was given", () => {
    assert.equal(computeWindow(0, 600, 100, ROW, 4).overscan, 4);
  });
});
