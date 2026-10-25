import catalog from "./marker-catalog.json";

/** The marker colors a project may take, in the order new projects receive them. */
export const MARKER_COLORS: readonly string[] = catalog.colors;

/** The marker icons a project may take. */
export const MARKER_ICONS: readonly string[] = catalog.icons;

/** The icon a marker shows instead of the initials when the project name has no letter. */
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

/** What a project's marker draws: a ground, and either initials or an icon on it. */
export interface MarkerLook {
  /** The CSS value of the colored ground, or `null` for the dark ground with a border. */
  readonly ground: string | null;
  /** The initials to show, `""` when the marker shows {@link MarkerLook.icon} instead. */
  readonly initials: string;
  /** The icon to show, `null` when the marker shows {@link MarkerLook.initials} instead. */
  readonly icon: string | null;
}

/**
 * The marker of a project named `name` with marker color `color`, `null` for
 * no color, and marker icon `icon`, `null` for the initials. Without an icon
 * and without a letter in the name, the marker shows {@link FALLBACK_ICON}.
 */
export function markerLook(color: string | null, icon: string | null, name: string): MarkerLook {
  const ground = color === null ? null : markerColorValue(color);
  if (icon !== null) {
    return { ground, initials: "", icon };
  }
  const initials = projectInitials(name);
  return initials === "" ? { ground, initials, icon: FALLBACK_ICON } : { ground, initials, icon: null };
}
