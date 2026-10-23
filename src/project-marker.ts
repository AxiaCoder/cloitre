/** How many marker colors `tokens.css` defines, as `--marker-1` to `--marker-<n>`. */
export const MARKER_COUNT = 8;

/**
 * The one or two letters shown in a project's square, upper-cased: the first
 * letter of the first two words when the name splits into several on `-`, `_`
 * or whitespace, otherwise its first two characters. An empty name gives `""`.
 */
export function projectInitials(name: string): string {
  const words = name.split(/[-_\s]+/u).filter((word) => word.length > 0);
  const letters =
    words.length >= 2
      ? words.slice(0, 2).map((word) => Array.from(word)[0] ?? "")
      : Array.from(words[0] ?? "").slice(0, 2);
  return letters.join("").toUpperCase();
}

/**
 * The marker color of project `id`, from 1 to {@link MARKER_COUNT}: ids follow
 * one another through the palette, and a project keeps its color for life.
 */
export function markerIndex(id: number): number {
  return (((id - 1) % MARKER_COUNT) + MARKER_COUNT) % MARKER_COUNT + 1;
}
