import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_ROOTS_KEY,
  RENAMED_STATE_KEY,
  STATE_KEY,
  clearHidden,
  toggleHidden,
  activeWorkspace,
  createWorkspace,
  loadState,
  nameFromPath,
  removeWorkspace,
  upsertWorkspace,
  type KeyValueStore,
} from "../workspaces";

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
});

describe("loadState", () => {
  it("creates a default tab from the fallback roots", () => {
    const state = loadState(store, ["/Users/flo/Projects"]);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].roots).toEqual(["/Users/flo/Projects"]);
    expect(state.activeId).toBe(state.workspaces[0].id);
  });

  it("migrates the pre-tabs roots list once", () => {
    store.setItem(LEGACY_ROOTS_KEY, JSON.stringify(["/a", "/b"]));
    const state = loadState(store);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].name).toBe("Tous");
    expect(state.workspaces[0].roots).toEqual(["/a", "/b"]);

    expect(state.workspaces[0].roots).toEqual(["/a", "/b"]);
  });

  it("round-trips a saved state", () => {
    const saved = {
      workspaces: [createWorkspace("Acme", ["/x"]), createWorkspace("Beta", ["/y"])],
      activeId: "",
      gutterWidth: null,
      collapsedRepos: [],
      richColors: false,
      selectedPath: null,
    };
    saved.activeId = saved.workspaces[1].id;
    store.setItem(STATE_KEY, JSON.stringify(saved));

    const state = loadState(store);
    expect(state.workspaces.map((w) => w.name)).toEqual(["Acme", "Beta"]);
    expect(activeWorkspace(state).name).toBe("Beta");
  });

  it("starts fresh on corrupt JSON rather than throwing", () => {
    store.setItem(STATE_KEY, "{not json");
    const state = loadState(store, ["/fallback"]);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].roots).toEqual(["/fallback"]);
  });

  it("drops malformed workspace entries", () => {
    store.setItem(
      STATE_KEY,
      JSON.stringify({
        workspaces: [{ id: "a", name: "Ok", roots: ["/x"] }, { id: 42 }, null],
        activeId: "a",
      }),
    );
    const state = loadState(store);
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0].name).toBe("Ok");
  });

  it("repairs an activeId pointing at a deleted tab", () => {
    store.setItem(
      STATE_KEY,
      JSON.stringify({
        workspaces: [{ id: "a", name: "Ok", roots: [] }],
        activeId: "gone",
      }),
    );
    expect(loadState(store).activeId).toBe("a");
  });
});

describe("mutations", () => {
  it("adds a tab and activates it", () => {
    const state = loadState(store, []);
    const next = upsertWorkspace(state, createWorkspace("Beta", ["/g"]));
    expect(next.workspaces).toHaveLength(2);
    expect(activeWorkspace(next).name).toBe("Beta");
  });

  it("updates a tab in place without changing the active one", () => {
    let state = loadState(store, []);
    const first = state.workspaces[0];
    state = upsertWorkspace(state, createWorkspace("Autre", []));
    const renamed = { ...first, name: "Renommé" };
    const next = upsertWorkspace(state, renamed);
    expect(next.workspaces).toHaveLength(2);
    expect(next.workspaces[0].name).toBe("Renommé");
    expect(next.activeId).toBe(state.activeId);
  });

  it("refuses to remove the last tab", () => {
    const state = loadState(store, []);
    expect(removeWorkspace(state, state.activeId)).toBe(state);
  });

  it("moves the selection when the active tab is removed", () => {
    let state = loadState(store, []);
    const keep = state.workspaces[0].id;
    state = upsertWorkspace(state, createWorkspace("B", []));
    const next = removeWorkspace(state, state.activeId);
    expect(next.workspaces).toHaveLength(1);
    expect(next.activeId).toBe(keep);
  });
});

describe("hidden list", () => {
  it("defaults to empty on a workspace stored before the field existed", () => {
    store.setItem(
      STATE_KEY,
      JSON.stringify({
        workspaces: [{ id: "a", name: "Acme", roots: ["/x"] }],
        activeId: "a",
      }),
    );
    expect(loadState(store).workspaces[0].hidden).toEqual([]);
  });

  it("toggles an entry on and off", () => {
    const workspace = createWorkspace("Acme", ["/x"]);
    const hidden = toggleHidden(workspace, "/p/repo");
    expect(hidden.hidden).toEqual(["/p/repo"]);
    expect(toggleHidden(hidden, "/p/repo").hidden).toEqual([]);
  });

  it("clears every entry at once", () => {
    let workspace = createWorkspace("Acme", ["/x"]);
    workspace = toggleHidden(workspace, "/a");
    workspace = toggleHidden(workspace, "/b");
    expect(clearHidden(workspace).hidden).toEqual([]);
  });

  it("survives a save/load round-trip", () => {
    const state = loadState(store, ["/x"]);
    const withHidden = upsertWorkspace(
      state,
      toggleHidden(state.workspaces[0], "/p/repo"),
    );
    store.setItem(STATE_KEY, JSON.stringify(withHidden));
    expect(loadState(store).workspaces[0].hidden).toEqual(["/p/repo"]);
  });
});

describe("rename migration", () => {
  it("adopts the state saved under the old gitscope key", () => {
    store.setItem(
      RENAMED_STATE_KEY,
      JSON.stringify({
        workspaces: [
          { id: "a", name: "Acme", roots: ["/p"], hidden: ["/p/x"] },
          { id: "b", name: "Beta", roots: ["/g"] },
        ],
        activeId: "b",
      }),
    );
    const state = loadState(store);
    expect(state.workspaces.map((w) => w.name)).toEqual(["Acme", "Beta"]);
    expect(state.activeId).toBe("b");
    expect(state.workspaces[0].hidden).toEqual(["/p/x"]);

  });

  it("prefers the current key when both exist", () => {
    store.setItem(
      RENAMED_STATE_KEY,
      JSON.stringify({ workspaces: [{ id: "old", name: "Ancien", roots: [] }], activeId: "old" }),
    );
    store.setItem(
      STATE_KEY,
      JSON.stringify({ workspaces: [{ id: "new", name: "Actuel", roots: [] }], activeId: "new" }),
    );
    expect(loadState(store).workspaces[0].name).toBe("Actuel");
  });
});

describe("gutterWidth", () => {
  const stored = (gutterWidth: unknown) =>
    JSON.stringify({
      workspaces: [{ id: "a", name: "A", roots: [] }],
      activeId: "a",
      ...(gutterWidth === undefined ? {} : { gutterWidth }),
    });

  it("is null when absent, meaning fit-to-lanes", () => {
    store.setItem(STATE_KEY, stored(undefined));
    expect(loadState(store).gutterWidth).toBeNull();
  });

  it("clamps an out-of-range value", () => {
    store.setItem(STATE_KEY, stored(4));
    expect(loadState(store).gutterWidth).toBe(24);
    store.setItem(STATE_KEY, stored(5000));
    expect(loadState(store).gutterWidth).toBe(640);
  });

  it("falls back to auto on a nonsense value", () => {
    // Never invent a width from garbage: auto is always safe to render.
    store.setItem(STATE_KEY, stored("wide"));
    expect(loadState(store).gutterWidth).toBeNull();
    store.setItem(STATE_KEY, stored(Number.NaN));
    expect(loadState(store).gutterWidth).toBeNull();
  });

  it("survives a round-trip, including the auto value", () => {
    const state = { ...loadState(store, ["/x"]), gutterWidth: 180 };
    store.setItem(STATE_KEY, JSON.stringify(state));
    expect(loadState(store).gutterWidth).toBe(180);

    store.setItem(STATE_KEY, JSON.stringify({ ...state, gutterWidth: null }));
    expect(loadState(store).gutterWidth).toBeNull();
  });
});

describe("collapsedRepos", () => {
  it("is empty when absent from a stored state", () => {
    store.setItem(
      STATE_KEY,
      JSON.stringify({ workspaces: [{ id: "a", name: "A", roots: [] }], activeId: "a" }),
    );
    expect(loadState(store).collapsedRepos).toEqual([]);
  });

  it("survives a round-trip", () => {
    const state = { ...loadState(store, ["/x"]), collapsedRepos: ["/p/api/.git"] };
    store.setItem(STATE_KEY, JSON.stringify(state));
    expect(loadState(store).collapsedRepos).toEqual(["/p/api/.git"]);
  });

  it("drops non-string entries", () => {
    store.setItem(
      STATE_KEY,
      JSON.stringify({
        workspaces: [{ id: "a", name: "A", roots: [] }],
        activeId: "a",
        collapsedRepos: ["/ok", 42, null],
      }),
    );
    expect(loadState(store).collapsedRepos).toEqual(["/ok"]);
  });
});

describe("richColors", () => {
  it("defaults to off", () => {
    store.setItem(
      STATE_KEY,
      JSON.stringify({ workspaces: [{ id: "a", name: "A", roots: [] }], activeId: "a" }),
    );
    expect(loadState(store).richColors).toBe(false);
  });

  it("only accepts a real boolean true", () => {
    const stored = (richColors: unknown) =>
      JSON.stringify({
        workspaces: [{ id: "a", name: "A", roots: [] }],
        activeId: "a",
        richColors,
      });
    store.setItem(STATE_KEY, stored(true));
    expect(loadState(store).richColors).toBe(true);
    store.setItem(STATE_KEY, stored("yes"));
    expect(loadState(store).richColors).toBe(false);
    store.setItem(STATE_KEY, stored(1));
    expect(loadState(store).richColors).toBe(false);
  });
});

describe("selectedPath", () => {
  it("is null when absent", () => {
    store.setItem(
      STATE_KEY,
      JSON.stringify({ workspaces: [{ id: "a", name: "A", roots: [] }], activeId: "a" }),
    );
    expect(loadState(store).selectedPath).toBeNull();
  });

  it("survives a round-trip", () => {
    const state = { ...loadState(store, ["/x"]), selectedPath: "/p/api" };
    store.setItem(STATE_KEY, JSON.stringify(state));
    expect(loadState(store).selectedPath).toBe("/p/api");
  });

  it("ignores a non-string value", () => {
    store.setItem(
      STATE_KEY,
      JSON.stringify({
        workspaces: [{ id: "a", name: "A", roots: [] }],
        activeId: "a",
        selectedPath: 42,
      }),
    );
    expect(loadState(store).selectedPath).toBeNull();
  });
});

describe("nameFromPath", () => {
  it("capitalises the last path segment", () => {
    expect(nameFromPath("/Users/flo/Projects/acme")).toBe("Acme");
    expect(nameFromPath("/Users/flo/Projects/beta/")).toBe("Beta");
  });

  it("falls back for an empty path", () => {
    expect(nameFromPath("/")).toBe("Projets");
  });
});
