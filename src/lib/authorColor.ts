/** FNV-1a: tiny, stable across runs, good enough spread for a hue. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface AuthorColor {
  bg: string;
  fg: string;
}

/**
 * A stable colour per author, derived from their email (falling back to their
 * name). Saturation and lightness are fixed so every avatar keeps the same
 * contrast against the dark text — only the hue varies.
 */
export function authorColor(email: string, name = ""): AuthorColor {
  const key = (email.trim() || name.trim()).toLowerCase();
  if (!key) return { bg: "#4a5568", fg: "#e6eaf0" };

  const hue = hash(key) % 360;
  return {
    bg: `hsl(${hue} 48% 60%)`,
    // Dark ink on a mid-lightness fill: legible at 9px for every hue, which a
    // white-on-colour scheme is not (yellows and cyans wash out).
    fg: "#12171f",
  };
}
