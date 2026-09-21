"use client";

import { useCallback, useState, type KeyboardEvent } from "react";

/**
 * Keyboard path for a chart's pointer readout.
 *
 * A chart's per-point numbers live only in the hover bubble, which made them
 * unreachable without a mouse. This supplies the equivalent: the chart's frame
 * takes focus, the arrow keys step from point to point, and the caller announces
 * the current value through a live region so the readout is not purely visual.
 *
 * Focus goes on the frame (`role="img"`), never on the SVG. The SVG is
 * `aria-hidden`, and a focusable element inside an aria-hidden subtree is a
 * contradiction that assistive technology reports as a defect — the frame is
 * also the node that already carries the chart's accessible name.
 */

export interface ChartKeyboard {
  /**
   * True while the keyboard is driving the readout. Callers use it to decide
   * whether to announce: pointer movement sets the same index but should not
   * fill a screen reader with values the user is only passing over.
   */
  keyboard: boolean;
  /** Spread onto the focusable frame element */
  frameProps: {
    tabIndex: 0;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onBlur: () => void;
  };
}

/**
 * @param count    Number of points along the axis
 * @param hover    Index the chart currently shows, or null
 * @param setHover Setter for that index
 */
export function useChartKeyboard(
  count: number,
  hover: number | null,
  setHover: (index: number | null) => void,
): ChartKeyboard {
  const [keyboard, setKeyboard] = useState(false);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (count <= 0) return;
      const last = count - 1;
      const { key } = event;

      if (key === "Escape") {
        setHover(null);
        return;
      }
      if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;

      // Entering from an edge steps inward rather than wrapping: a wrap would
      // jump the readout across the whole axis on a single keypress.
      let next: number;
      if (key === "ArrowRight") next = hover == null ? 0 : Math.min(last, hover + 1);
      else if (key === "ArrowLeft") next = hover == null ? last : Math.max(0, hover - 1);
      else if (key === "Home") next = 0;
      else next = last;

      // The frame is a widget while it holds focus, so the arrows move the
      // readout instead of scrolling the page — the same bargain a focused
      // slider or listbox makes.
      event.preventDefault();
      setKeyboard(true);
      setHover(next);
    },
    [count, hover, setHover],
  );

  return {
    keyboard,
    frameProps: {
      tabIndex: 0,
      onKeyDown,
      // Deliberately no focus handler: the frame is click-focusable too, and
      // latching the flag there would make every later mouse move rewrite the
      // live region — the chatter this flag exists to prevent. Only a keypress
      // turns it on; blur turns it off.
      onBlur: () => {
        setKeyboard(false);
        setHover(null);
      },
    },
  };
}
