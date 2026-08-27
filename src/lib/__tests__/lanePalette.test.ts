import { describe, expect, it } from "vitest";
import {
  ROLE_COLORS,
  laneBadgeColors,
  laneColor,
  lanePaletteColor,
  paletteIndex,
  rolesFromLayout,
} from "../laneColors";

const hueOf = (css: string): number =>
  Number(css.match(/oklch\([\d.]+ [\d.]+ ([\d.]+)/)![1]);
const lightOf = (css: string): number =>
  Number(css.match(/oklch\(([\d.]+)/)![1]);

/** Shortest distance between two hues on the wheel. */
const hueGap = (a: number, b: number): number =>
  180 - Math.abs(Math.abs(a - b) - 180);

describe("lanePaletteColor", () => {
  it("steps evenly along the ramp", () => {
    // Lanes walk the ramp in order, so neighbours are neighbouring hues. The
    // step must still be big enough to see.
    for (let lane = 0; lane < 7; lane++) {
      const gap = hueGap(
        hueOf(lanePaletteColor(lane)),
        hueOf(lanePaletteColor(lane + 1)),
      );
      expect(gap, `lanes ${lane} and ${lane + 1} are ${gap}° apart`).toBeGreaterThan(
        15,
      );
    }
  });

  it("runs violet to yellow in order", () => {
    expect(hueOf(lanePaletteColor(0))).toBe(300);
    expect(hueOf(lanePaletteColor(7))).toBe(95);
  });

  it("stays clear of the green and blue roles", () => {
    // The ramp is warm by design (violet → yellow), so it never approaches the
    // green trunk or the blue integration branch. It does pass through orange,
    // where HEAD lives: HEAD stays identifiable by its filled badge and halo.
    for (let lane = 0; lane < 40; lane++) {
      const hue = hueOf(lanePaletteColor(lane));
      // OKLCH green sits near 145, blue near 255.
      expect(hueGap(hue, 145)).toBeGreaterThan(30);
      expect(hueGap(hue, 255)).toBeGreaterThan(30);
    }
  });

  it("keeps every lane on the warm ramp", () => {
    for (let lane = 0; lane < 24; lane++) {
      const hue = hueOf(lanePaletteColor(lane));
      // Violet (300) round to yellow (95): outside that arc is off-palette.
      const onRamp = hue >= 295 || hue <= 100;
      expect(onRamp, `lane ${lane} at ${hue}° is off the ramp`).toBe(true);
    }
  });

  it("darkens past one turn so lane 0 and lane 8 differ", () => {
    expect(hueOf(lanePaletteColor(0))).toBe(hueOf(lanePaletteColor(8)));
    expect(lightOf(lanePaletteColor(8))).toBeLessThan(lightOf(lanePaletteColor(0)));
  });

  it("is deterministic", () => {
    expect(lanePaletteColor(3)).toBe(lanePaletteColor(3));
  });
});

describe("laneBadgeColors", () => {
  it("puts badge and lane on the same hue", () => {
    for (let lane = 0; lane < 10; lane++) {
      expect(hueOf(laneBadgeColors(lane).text)).toBe(hueOf(lanePaletteColor(lane)));
    }
  });

  it("keeps its three parts on one hue", () => {
    const colors = laneBadgeColors(4);
    expect(hueOf(colors.border)).toBe(hueOf(colors.text));
    expect(hueOf(colors.background)).toBe(hueOf(colors.text));
  });

  it("never emits a fixed role colour", () => {
    const reserved = Object.values(ROLE_COLORS);
    for (let lane = 0; lane < 20; lane++) {
      expect(reserved).not.toContain(laneBadgeColors(lane).text);
    }
  });

  it("uses oklch so hue steps read evenly", () => {
    expect(lanePaletteColor(0)).toMatch(/^oklch\(/);
    expect(laneBadgeColors(0).text).toMatch(/^oklch\(/);
  });
});

describe("paletteIndex", () => {
  const bothPinned = rolesFromLayout([0, 1]);

  it("starts the ramp on the first lane without a role", () => {
    // master on lane 0 and develop on lane 1 have their own colours; the first
    // feature branch must get violet, not the ramp's third hue.
    expect(paletteIndex(2, bothPinned)).toBe(0);
    expect(laneColor(2, bothPinned)).toBe(lanePaletteColor(0));
    expect(laneColor(3, bothPinned)).toBe(lanePaletteColor(1));
  });

  it("shifts by one when only the trunk is pinned", () => {
    const trunkOnly = rolesFromLayout([0]);
    expect(paletteIndex(1, trunkOnly)).toBe(0);
    expect(laneColor(1, trunkOnly)).toBe(lanePaletteColor(0));
  });

  it("does not shift when no lane carries a role", () => {
    const none = rolesFromLayout([-1, -1]);
    expect(paletteIndex(0, none)).toBe(0);
    expect(paletteIndex(3, none)).toBe(3);
  });

  it("ignores a roled lane sitting to the right", () => {
    // develop reserved lane 5 for some reason: lanes left of it are unaffected.
    const odd = rolesFromLayout([0, 5]);
    expect(paletteIndex(2, odd)).toBe(1);
    expect(paletteIndex(6, odd)).toBe(4);
  });

  it("keeps roled lanes on their fixed colours", () => {
    expect(laneColor(0, bothPinned)).toBe(ROLE_COLORS.trunk);
    expect(laneColor(1, bothPinned)).toBe(ROLE_COLORS.integration);
  });

  it("keeps badge and stroke on the same ramp position", () => {
    const index = paletteIndex(4, bothPinned);
    const hueOfCss = (css: string) =>
      css.match(/oklch\([\d.]+ [\d.]+ ([\d.]+)/)![1];
    expect(hueOfCss(laneBadgeColors(index).text)).toBe(
      hueOfCss(laneColor(4, bothPinned)),
    );
  });
});
