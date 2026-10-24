import catalog from "./marker-catalog.json";

/** The marker colors a project may take, in the order new projects receive them. */
export const MARKER_COLORS: readonly string[] = catalog.colors;

/** The marker icons a project may take. */
export const MARKER_ICONS: readonly string[] = catalog.icons;

/** The icon a color marker shows when the project name has no letter to show. */
export const FALLBACK_ICON = "folder";

/** The CSS value of marker color `color`, a name of {@link MARKER_COLORS}. */
export function markerColorValue(color: string): string {
  return `var(--marker-${color})`;
}

/**
 * The one or two letters shown in a project's square, upper-cased. Only
 * letters count: the name splits into words on `-`, `_`, `.` and whitespace,
 * and words without a letter are skipped. With two words or more, the first
 * letter of each of the first two; with one, its first two letters. A name
 * without any letter (digits, symbols, emoji only, or empty) gives `""`: the
 * marker then shows {@link FALLBACK_ICON} instead.
 */
export function projectInitials(name: string): string {
  const words = name
    .split(/[-_.\s]+/u)
    .map((word) => word.match(/\p{L}/gu) ?? [])
    .filter((letters) => letters.length > 0);
  const letters = words.length >= 2 ? words.slice(0, 2).map((word) => word[0]) : (words[0] ?? []).slice(0, 2);
  return letters.join("").toUpperCase();
}
