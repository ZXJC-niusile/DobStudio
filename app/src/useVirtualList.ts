/**
 * Windowed list rendering.
 *
 * A two-hour video produces roughly 1,200 cues, and each row here carries two
 * `<textarea>`s. Rendering all of them means ~3,600 DOM nodes before anything
 * else on the page, and typing in one of them re-renders every sibling. This
 * keeps only the visible slice plus a small overscan mounted.
 *
 * The container must have a bounded height and `overflow-y: auto` — the hook
 * measures its scrollTop and clientHeight to decide what is visible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface VirtualWindow {
  /** Index of the first row to render. */
  start: number;
  /** Index one past the last row to render. */
  end: number;
  /** Total height of the scrollable content, in pixels. */
  totalHeight: number;
  /** Offset to apply to the rendered slice, so rows land where they belong. */
  offsetTop: number;
  /** Rows rendered outside the viewport, to cover fast scrolling. */
  overscan: number;
}

export interface UseVirtualListOptions {
  count: number;
  /** Height of one row, in pixels. Must be stable for the maths to hold. */
  rowHeight: number;
  /** Extra rows rendered above and below the viewport. Default 8. */
  overscan?: number;
}

/**
 * The windowing arithmetic, as a pure function.
 *
 * Split out of the hook so it can be tested without a DOM: the hook's only
 * remaining job is reading scroll geometry and subscribing to events, which is
 * exactly the part that needs a browser.
 */
export function computeWindow(
  scrollTop: number,
  viewportHeight: number,
  count: number,
  rowHeight: number,
  overscan: number,
): VirtualWindow {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight));
  const visible = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const start = Math.max(0, first - overscan);
  // `end` is clamped to the list, so `start` must be too. Without this, a
  // scroll past the bottom (rubber-banding, or a stale scrollTop after the
  // list shrank) leaves start far beyond the end and pushes the rendered slice
  // hundreds of thousands of pixels off screen — a blank viewport.
  const end = Math.min(count, first + visible + overscan);
  const clampedStart = Math.min(start, Math.max(0, end - 1));
  return {
    start: clampedStart,
    end,
    totalHeight: count * rowHeight,
    offsetTop: clampedStart * rowHeight,
    overscan,
  };
}

/**
 * Subscribe to a scroll container and report the visible row range.
 *
 * `containerRef` must point at the scrolling element. Returns `null` until it
 * has been measured, so the caller can render a placeholder rather than guess.
 */
export function useVirtualList(
  containerRef: React.RefObject<HTMLElement | null>,
  { count, rowHeight, overscan = 8 }: UseVirtualListOptions,
): VirtualWindow | null {
  const [range, setRange] = useState<VirtualWindow | null>(null);
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    const element = containerRef.current;
    if (element === null) return;

    const viewport = element.clientHeight;
    // Before layout the container reports zero height; fall back to the
    // element's own bounding box so the first paint is not empty.
    const height =
      viewport > 0 ? viewport : element.getBoundingClientRect().height;

    setRange(
      computeWindow(element.scrollTop, height, count, rowHeight, overscan),
    );
  }, [containerRef, count, rowHeight, overscan]);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;

    measure();

    // Coalesce scroll events to one measurement per animation frame.
    const onScroll = (): void => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        measure();
      });
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    globalThis.addEventListener("resize", onScroll);

    // The container's height can change without a window resize — a panel
    // collapsing, a font loading — so observe it directly.
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(onScroll);
    observer?.observe(element);

    return () => {
      element.removeEventListener("scroll", onScroll);
      globalThis.removeEventListener("resize", onScroll);
      observer?.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [containerRef, measure]);

  // A shorter list must re-measure even without a scroll event.
  useEffect(() => {
    measure();
  }, [count, measure]);

  return range;
}

/** Convenience wrapper for the common "render rows[i]" case. */
export function useVirtualRows<T>(
  containerRef: React.RefObject<HTMLElement | null>,
  rows: readonly T[],
  rowHeight: number,
  overscan?: number,
): { items: T[]; startIndex: number; padTop: number; totalHeight: number } {
  const virtual = useVirtualList(containerRef, {
    count: rows.length,
    rowHeight,
    overscan,
  });

  return useMemo(() => {
    if (virtual === null) {
      // Nothing measured yet: render a small first page rather than nothing.
      const head = rows.slice(0, 20);
      return {
        items: head,
        startIndex: 0,
        padTop: 0,
        totalHeight: rows.length * rowHeight,
      };
    }
    return {
      items: rows.slice(virtual.start, virtual.end),
      startIndex: virtual.start,
      padTop: virtual.offsetTop,
      totalHeight: virtual.totalHeight,
    };
  }, [rows, rowHeight, virtual]);
}
