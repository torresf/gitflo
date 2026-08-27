import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hideTip, showTip, subscribeTip, tip, type TipState } from "../tooltip";

let seen: TipState | null = null;
let unsubscribe = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  hideTip();
  seen = null;
  unsubscribe = subscribeTip((s) => {
    seen = s;
  });
});

afterEach(() => {
  unsubscribe();
  hideTip();
  vi.useRealTimers();
});

describe("tip()", () => {
  it("returns handlers for a string", () => {
    expect(Object.keys(tip("hello"))).toContain("onMouseEnter");
  });

  it("returns handlers for structured content", () => {
    expect(Object.keys(tip({ title: "hello" }))).toContain("onMouseEnter");
  });

  it("returns nothing for empty content", () => {
    expect(tip(null)).toEqual({});
    expect(tip({ title: "" })).toEqual({});
  });
});

describe("show/hide", () => {
  it("shows after the delay", () => {
    showTip({ title: "hello" }, 10, 20);
    expect(seen).toBeNull();
    vi.advanceTimersByTime(200);
    expect(seen?.content.title).toBe("hello");
  });

  it("still appears while the pointer keeps moving", () => {
    // onMouseMove fires continuously; if each call reset the timer, the
    // tooltip would never appear on a moving pointer.
    for (let i = 0; i < 20; i++) {
      showTip({ title: "hello" }, i, i);
      vi.advanceTimersByTime(20);
    }
    expect(seen?.content.title).toBe("hello");
  });

  it("follows the pointer once visible", () => {
    showTip({ title: "hello" }, 10, 20);
    vi.advanceTimersByTime(200);
    showTip({ title: "hello" }, 99, 88);
    expect(seen?.x).toBe(99);
  });

  it("hides on demand", () => {
    showTip({ title: "hello" }, 10, 20);
    vi.advanceTimersByTime(200);
    hideTip();
    expect(seen).toBeNull();
  });
});
