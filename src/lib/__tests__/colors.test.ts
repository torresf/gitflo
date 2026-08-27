import { describe, expect, it } from "vitest";
import { authorColor } from "../authorColor";
import {
  ROLE_COLORS,
  laneColor,
  lanePaletteColor,
  laneRole,
  rolesFromLayout,
} from "../laneColors";

describe("laneRole", () => {
  const roles = (pinnedCount: number) =>
    rolesFromLayout(
      // Emulate buildGraph having reserved lanes 0..pinnedCount-1.
      Array.from({ length: pinnedCount }, (_, i) => i),
    );

  it("assigns trunk and integration to the reserved lanes", () => {
    expect(laneRole(0, roles(2))).toBe("trunk");
    expect(laneRole(1, roles(2))).toBe("integration");
    expect(laneRole(5, roles(2))).toBe("other");
  });

  it("claims no reserved lane when nothing was pinned", () => {
    // A repo with neither main nor develop: lane 0 is just another branch.
    expect(laneRole(0, roles(0))).toBe("other");
    expect(laneRole(1, roles(0))).toBe("other");
  });

  it("treats lane 1 as ordinary when only the trunk was pinned", () => {
    expect(laneRole(0, roles(1))).toBe("trunk");
    expect(laneRole(1, roles(1))).toBe("other");
  });
});

describe("laneColor", () => {
  it("returns the fixed colours for the meaningful lanes", () => {
    const roles = rolesFromLayout([0, 1]);
    expect(laneColor(0, roles)).toBe(ROLE_COLORS.trunk);
    expect(laneColor(1, roles)).toBe(ROLE_COLORS.integration);
    // Everything else walks the ramp, offset past the two roled lanes.
    expect(laneColor(4, roles)).toBe(lanePaletteColor(2));
  });

  it("walks the ramp for the rest", () => {
    const roles = rolesFromLayout([0, 1]);
    // Lane 2 is the first without a role, so it opens the ramp.
    expect(laneColor(2, roles)).toBe(lanePaletteColor(0));
    // Same hue one turn later, but a different lightness.
    expect(laneColor(10, roles)).not.toBe(laneColor(2, roles));
  });

  it("never gives an ordinary lane one of the three fixed colours", () => {
    const roles = rolesFromLayout([0, 1]);
    const reserved = Object.values(ROLE_COLORS);
    for (let lane = 4; lane < 40; lane++) {
      expect(reserved).not.toContain(laneColor(lane, roles));
    }
  });

  it("does not depend on the badge mode", () => {
    // Flipping rich colours must never repaint the graph.
    const roles = rolesFromLayout([0, 1]);
    expect(laneColor(5, roles)).toBe(lanePaletteColor(3));
  });
});

describe("rolesFromLayout", () => {
  it("ignores a pinned sha that got no lane", () => {
    // A filtered page can show neither trunk nor develop: lane 0 is then an
    // ordinary branch and must not be painted as the trunk.
    const roles = rolesFromLayout([-1, -1]);
    expect(roles.trunkLane).toBeNull();
    expect(roles.integrationLane).toBeNull();
    expect(laneRole(0, roles)).toBe("other");
  });

  it("maps develop to whichever lane it actually got", () => {
    // No trunk on the page: develop was reserved lane 0.
    const roles = rolesFromLayout([-1, 0]);
    expect(roles.trunkLane).toBeNull();
    expect(laneRole(0, roles)).toBe("integration");
    expect(laneColor(0, roles)).toBe(ROLE_COLORS.integration);
  });
});

describe("authorColor", () => {
  it("is stable for the same author", () => {
    expect(authorColor("dev@example.com")).toEqual(
      authorColor("dev@example.com"),
    );
  });

  it("ignores case and surrounding spaces", () => {
    expect(authorColor("  Dev@Example.COM ")).toEqual(
      authorColor("dev@example.com"),
    );
  });

  it("separates the authors of a real team", () => {
    const emails = [
      "dev@example.com",
      "bot@example.com",
      "alex@example.com",
      "sam@example.com",
      "robin@example.com",
    ];
    const hues = new Set(emails.map((e) => authorColor(e).bg));
    expect(hues.size).toBe(emails.length);
  });

  it("falls back to the name when there is no email", () => {
    const byName = authorColor("", "BuildBot");
    expect(byName).toEqual(authorColor("", "buildbot"));
    expect(byName.bg).not.toBe(authorColor("", "Dev One").bg);
  });

  it("returns a readable neutral when it has nothing to hash", () => {
    const anonymous = authorColor("", "");
    expect(anonymous.bg).toBe("#4a5568");
    expect(anonymous.fg).toBe("#e6eaf0");
  });
});
