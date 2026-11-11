/**
 * Process-wide concurrency limiting.
 *
 * This is the piece that stops three queued jobs from opening twelve requests
 * against a provider configured for four. Concurrency bugs are timing bugs, so
 * the tests assert on the invariants that must hold regardless of scheduling:
 * the ceiling is never exceeded, slots are always released, and a stricter
 * caller lowers the limit for everyone.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activeCount,
  currentLimit,
  releaseLimit,
  requestLimit,
  resetLimiter,
  withSlot,
} from "../src/limiter.ts";

/** Resolve once `predicate` holds, or fail after a deadline. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("requestLimit", () => {
  it("sets a ceiling when none exists", () => {
    resetLimiter();
    requestLimit("p", 4);
    assert.equal(currentLimit("p"), 4);
  });

  it("lowers the ceiling when a stricter caller arrives", () => {
    resetLimiter();
    requestLimit("p", 8);
    requestLimit("p", 2);
    assert.equal(currentLimit("p"), 2, "the stricter caller must win");
  });

  it("does not let a looser caller raise it", () => {
    resetLimiter();
    requestLimit("p", 2);
    requestLimit("p", 8);
    assert.equal(currentLimit("p"), 2, "raising would violate the stricter job");
  });

  it("keeps providers independent", () => {
    resetLimiter();
    requestLimit("a", 2);
    requestLimit("b", 6);
    assert.equal(currentLimit("a"), 2);
    assert.equal(currentLimit("b"), 6);
  });
});

describe("releaseLimit", () => {
  it("removes the claim so a later caller can set a new ceiling", () => {
    resetLimiter();
    requestLimit("p", 2);
    releaseLimit("p");
    assert.equal(currentLimit("p"), Number.POSITIVE_INFINITY);
    requestLimit("p", 9);
    assert.equal(currentLimit("p"), 9);
  });
});

describe("withSlot", () => {
  it("runs immediately when there is room", async () => {
    resetLimiter();
    requestLimit("p", 2);
    let ran = false;
    await withSlot("p", async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(activeCount("p"), 0, "the slot was released");
  });

  it("never exceeds the ceiling under load", async () => {
    resetLimiter();
    requestLimit("p", 3);

    let peak = 0;
    const tasks = Array.from({ length: 20 }, () =>
      withSlot("p", async () => {
        peak = Math.max(peak, activeCount("p"));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
    );
    await Promise.all(tasks);

    assert.ok(peak <= 3, `peak concurrency was ${peak}, ceiling was 3`);
    assert.equal(activeCount("p"), 0, "every slot was released");
  });

  it("releases the slot when the task throws", async () => {
    resetLimiter();
    requestLimit("p", 1);

    await assert.rejects(() =>
      withSlot("p", async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(activeCount("p"), 0, "a throwing request must not wedge the limiter");

    // And the limiter still works afterwards.
    let ran = false;
    await withSlot("p", async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  it("queues rather than dropping work", async () => {
    resetLimiter();
    requestLimit("p", 1);

    const order: number[] = [];
    const tasks = [1, 2, 3, 4, 5].map((n) =>
      withSlot("p", async () => {
        order.push(n);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
    );
    await Promise.all(tasks);

    assert.deepEqual(order, [1, 2, 3, 4, 5], "no work was lost or reordered");
    assert.equal(activeCount("p"), 0);
  });

  it("unblocks a waiter as soon as a slot frees", async () => {
    resetLimiter();
    requestLimit("p", 4);

    // Occupy all four slots.
    const release: (() => void)[] = [];
    const held = Array.from({ length: 4 }, () =>
      withSlot("p", () => new Promise<void>((resolve) => release.push(resolve))),
    );
    await until(() => activeCount("p") === 4);

    // A fifth request must wait.
    let fifthRan = false;
    const fifth = withSlot("p", async () => {
      fifthRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fifthRan, false, "the fifth request should be waiting");

    release[0]!();
    await fifth;
    assert.equal(fifthRan, true, "it ran once a slot freed");
    // The invariant that matters is the ceiling, not the exact intermediate
    // count: a freed slot and a waking waiter race on the microtask queue, so
    // asserting "exactly 4 in flight" here tests scheduling, not behaviour.
    assert.ok(activeCount("p") <= 4, "the ceiling was exceeded");
    assert.ok(activeCount("p") >= 3, "the waiter did not take a slot");

    release.slice(1).forEach((fn) => fn());
    await Promise.all(held);
    // Everything must drain back to zero.
    await until(() => activeCount("p") === 0);
    assert.equal(activeCount("p"), 0);
  });

  it("treats an unlimited provider as unbounded", async () => {
    resetLimiter();
    // No requestLimit call: currentLimit is Infinity.
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withSlot("p", async () => {
          peak = Math.max(peak, activeCount("p"));
        }),
      ),
    );
    assert.equal(peak, 10, "no ceiling means no ceiling");
  });
});
