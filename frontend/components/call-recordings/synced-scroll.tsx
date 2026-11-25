"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Puts the horizontal scrollbar of a wide table ABOVE it (right over the column headers) instead of at the bottom, so it is always in reach however many rows the page has.
 *  - It scrolls only the table: the real scroller is the shared Table's own container (data-slot="table-container"); this bar and that container mirror each other, so dragging the bar,
 *    the trackpad, shift + wheel and touch all move both and the page / sidebar never shift sideways.
 *  - The bar is sticky below the app's 4rem header, so it stays on screen while scrolling down through the rows.
 *  - The table's own bottom scrollbar is hidden (it still scrolls); the bar disappears when the table fits.
 * It wraps a <Table> without changing it (structure, column widths, pagination and alignment are untouched).
 */
export function SyncedScroll({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const top = bar.current;
    const scroller = wrap.current?.querySelector<HTMLElement>('[data-slot="table-container"]');
    if (!top || !scroller) return;

    // Whichever side the user moves drives the other; the flag stops them echoing back and forth.
    let driving: "top" | "body" | null = null;
    const release = () => requestAnimationFrame(() => (driving = null));
    const onTop = () => {
      if (driving === "body") return;
      driving = "top";
      scroller.scrollLeft = top.scrollLeft;
      release();
    };
    const onBody = () => {
      if (driving === "top") return;
      driving = "body";
      top.scrollLeft = scroller.scrollLeft;
      release();
    };

    const measure = () => {
      setWidth(scroller.scrollWidth);
      setOverflowing(scroller.scrollWidth > scroller.clientWidth + 1);
      top.scrollLeft = scroller.scrollLeft;
    };
    measure();

    top.addEventListener("scroll", onTop, { passive: true });
    scroller.addEventListener("scroll", onBody, { passive: true });
    // The table grows or shrinks with every page, filter and window size.
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);

    return () => {
      top.removeEventListener("scroll", onTop);
      scroller.removeEventListener("scroll", onBody);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={wrap}
      className="[&_[data-slot=table-container]]:[scrollbar-width:none] [&_[data-slot=table-container]::-webkit-scrollbar]:hidden"
    >
      <div
        ref={bar}
        className="sticky top-16 z-20 overflow-x-auto overflow-y-hidden bg-card"
        style={{ display: overflowing ? "block" : "none" }}
        aria-hidden="true"
        data-testid="top-scrollbar"
      >
        <div style={{ width, height: 1 }} />
      </div>
      {children}
    </div>
  );
}
