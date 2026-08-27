/**
 * Compact age label, e.g. `25m`, `21h`, `18j`, `6mo`, `2a`.
 *
 * Deliberately space-free: these sit in narrow fixed-width columns of the
 * branch and commit lists, and a label like "25 min" wrapped onto two lines.
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return "<1m";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}j`;
  const months = Math.round(days / 30.4);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}a`;
}

export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Strip the remote prefix: "origin/feature/x" -> "feature/x". */
export function stripRemote(short: string): string {
  const slash = short.indexOf("/");
  return slash === -1 ? short : short.slice(slash + 1);
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
