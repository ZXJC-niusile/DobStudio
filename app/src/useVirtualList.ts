import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface VirtualWindow {
  start: number;
  end: number;
  totalHeight: number;
  offsetTop: number;
}

export interface UseVirtualListOptions {
  count: number;
  rowHeight: number;
  overscan?: number;
}

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

  const end = Math.min(count, first + visible + overscan);
  const clampedStart = Math.min(start, Math.max(0, end - 1));
  return {
    start: clampedStart,
    end,
    totalHeight: count * rowHeight,
    offsetTop: clampedStart * rowHeight,
  };
}

export function useVirtualList(
  containerRef: React.RefObject<HTMLElement | null>,
  { count, rowHeight, overscan = 8 }: UseVirtualListOptions,
): VirtualWindow | null {
  const [range, setRange] = useState<VirtualWindow | null>(null);
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    const element = containerRef.current;
    if (element === null) return;

    const height = element.clientHeight;

    setRange(
      computeWindow(element.scrollTop, height, count, rowHeight, overscan),
    );
  }, [containerRef, count, rowHeight, overscan]);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;

    measure();

    const onScroll = (): void => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        measure();
      });
    };

    element.addEventListener("scroll", onScroll, { passive: true });

    const observer = new ResizeObserver(onScroll);
    observer.observe(element);

    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [containerRef, measure]);

  return range;
}

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
