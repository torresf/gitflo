import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeSettings = vi.fn((_content: string) => Promise.resolve());
const readSettings = vi.fn((): Promise<string | null> => Promise.resolve(null));

vi.mock("../../api", () => ({
  api: {
    writeSettings: (content: string) => writeSettings(content),
    readSettings: () => readSettings(),
  },
}));

const { flushSettings, persistSettings } = await import("../settings");
const { createWorkspace } = await import("../workspaces");

const state = (gutterWidth: number) => ({
  workspaces: [createWorkspace("A", ["/x"])],
  activeId: "a",
  gutterWidth,
  collapsedRepos: [],
  richColors: false,
  selectedPath: null,
});

beforeEach(() => {
  writeSettings.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("persistSettings", () => {
  it("coalesces a burst into a single write carrying the last state", async () => {
    // What a gutter drag produces: dozens of updates in a few frames.
    for (let w = 60; w <= 200; w += 10) persistSettings(state(w));

    expect(writeSettings).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();

    expect(writeSettings).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSettings.mock.calls[0][0]).gutterWidth).toBe(200);
  });

  it("writes again after the window has passed", async () => {
    persistSettings(state(100));
    await vi.runAllTimersAsync();
    expect(writeSettings).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    persistSettings(state(110));
    await vi.runAllTimersAsync();

    expect(writeSettings).toHaveBeenCalledTimes(2);
    expect(JSON.parse(writeSettings.mock.calls[1][0]).gutterWidth).toBe(110);
  });

  it("flushes a pending write immediately on demand", async () => {
    persistSettings(state(150));
    await flushSettings();
    expect(writeSettings).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writeSettings.mock.calls[0][0]).gutterWidth).toBe(150);
  });

  it("flushing with nothing pending writes nothing", async () => {
    await flushSettings();
    expect(writeSettings).not.toHaveBeenCalled();
  });
});
