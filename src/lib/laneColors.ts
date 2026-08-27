/**
 * Lane colouring is semantic, not positional.
 *
 * The trunk and the integration branch always get the same two colours in
 * every repo, so `master` and `develop` are recognisable at a glance without
 * reading a label. The branch currently checked out gets the third fixed
 * colour — "where I am" should never move. Every other lane cycles a palette
 * chosen to avoid those three, at full strength: several feature branches are
 * often open at once and they have to stay told apart.
 */
export type LaneRole = "trunk" | "integration" | "other";

export const ROLE_COLORS: Record<Exclude<LaneRole, "other">, string> = {
  trunk: "#57d38c",
  integration: "#4c9aff",
};

/** Tailwind text classes mirroring ROLE_COLORS, for the branch list icons. */
export const ROLE_TEXT_CLASS: Record<Exclude<LaneRole, "other">, string> = {
  trunk: "text-ahead",
  integration: "text-accent",
};

/**
 * Lane palette: a warm ramp from violet through pink, red and orange to
 * yellow, in OKLCH.
 *
 * OKLCH rather than HSL because it is perceptually uniform: equal steps in
 * hue look equally different, where HSL crowds the greens and thins the
 * blues, making a ramp read unevenly. Lightness and chroma stay constant, so
 * every lane carries the same visual weight.
 */
const RAMP_START_HUE = 300;
/** 455 wraps to 95° — yellow. Kept unwrapped so the ramp is monotonic. */
const RAMP_END_HUE = 455;
const RAMP_STEPS = 8;

/**
 * Lanes walk the ramp in order: lane 0 violet, then pink, red, orange, and
 * lane 7 yellow. Neighbouring lanes are therefore neighbouring hues — the
 * ramp reads as a gradient across the gutter, at the cost of adjacent lanes
 * being closer than an interleaved order would make them.
 */
const rampHue = (lane: number): number => {
  const t = (lane % RAMP_STEPS) / (RAMP_STEPS - 1);
  return (RAMP_START_HUE + t * (RAMP_END_HUE - RAMP_START_HUE)) % 360;
};

/** Lightness drops a notch per full turn, so lane 0 and lane 8 differ. */
const rampLightness = (lane: number): number =>
  0.74 - Math.min(Math.floor(lane / RAMP_STEPS), 2) * 0.1;

/** Stroke colour for a ramp position (see `paletteIndex`). */
export function lanePaletteColor(lane: number): string {
  return `oklch(${rampLightness(lane).toFixed(2)} 0.15 ${rampHue(lane).toFixed(1)})`;
}

/** Filled variant, for the badge of the checked-out branch. */
export function laneSolidColors(lane: number): {
  border: string;
  background: string;
  text: string;
} {
  const hue = rampHue(lane).toFixed(1);
  const lightness = rampLightness(lane);
  const fill = `oklch(${lightness.toFixed(2)} 0.15 ${hue})`;
  return { border: fill, background: fill, text: "#12171f" };
}

/** Badge colours on the same hue as the lane, for border, fill and text. */
export function laneBadgeColors(lane: number): {
  border: string;
  background: string;
  text: string;
} {
  const hue = rampHue(lane).toFixed(1);
  const lightness = rampLightness(lane);
  return {
    border: `oklch(${lightness.toFixed(2)} 0.14 ${hue} / 0.55)`,
    background: `oklch(${lightness.toFixed(2)} 0.14 ${hue} / 0.15)`,
    text: `oklch(${Math.min(lightness + 0.06, 0.86).toFixed(2)} 0.16 ${hue})`,
  };
}

export interface LaneRoles {
  /** Lane actually holding the trunk on this page, or null if absent. */
  trunkLane: number | null;
  /** Lane actually holding the integration branch, or null if absent. */
  integrationLane: number | null;
}

/** Build the roles from what buildGraph reserved, never from assumptions. */
export function rolesFromLayout(pinnedLanes: number[]): LaneRoles {
  const lane = (i: number) =>
    pinnedLanes[i] !== undefined && pinnedLanes[i] >= 0 ? pinnedLanes[i] : null;
  return { trunkLane: lane(0), integrationLane: lane(1) };
}

/**
 * A lane's role.
 *
 * There is no role for HEAD: the checked-out branch takes its own lane's
 * colour, and stays identifiable by the halo on its dot, the filled badge and
 * the check mark in the branch list. Giving it a colour of its own meant the
 * same branch changed colour depending on what happened to be checked out.
 */
export function laneRole(lane: number, roles: LaneRoles): LaneRole {
  if (roles.trunkLane !== null && lane === roles.trunkLane) return "trunk";
  if (roles.integrationLane !== null && lane === roles.integrationLane)
    return "integration";
  return "other";
}

/**
 * Position of a lane along the ramp, ignoring the lanes that carry a role.
 *
 * The trunk and the integration branch already have their own colours, so they
 * must not consume ramp slots: with `master` on lane 0 and `develop` on lane 1,
 * the ramp would otherwise start at its third hue on the first ordinary
 * branch. Counting only the lanes to its left keeps the first feature branch at
 * violet, whatever the repo's shape.
 */
export function paletteIndex(lane: number, roles: LaneRoles): number {
  let roled = 0;
  if (roles.trunkLane !== null && roles.trunkLane < lane) roled += 1;
  if (roles.integrationLane !== null && roles.integrationLane < lane) roled += 1;
  return Math.max(0, lane - roled);
}

/**
 * Colour of a lane. Roles win; everything else walks the ramp.
 *
 * There is deliberately only ONE lane palette: the rich/plain toggle governs
 * the BADGES, and having it repaint the graph too made flipping it feel like
 * the history had changed.
 */
export function laneColor(lane: number, roles: LaneRoles): string {
  const role = laneRole(lane, roles);
  if (role !== "other") return ROLE_COLORS[role];
  return lanePaletteColor(paletteIndex(lane, roles));
}
