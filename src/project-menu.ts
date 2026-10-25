import { FALLBACK_ICON, MARKER_COLORS, MARKER_ICONS, projectInitials } from "./project-marker";

/** How many choices a row of the menu's grid holds; the stylesheet lays the grid out with as many columns. */
export const GRID_COLUMNS = 6;

/** The path data of the trash drawing of the menu's remove entry, a 24×24 outline like the marker icons. */
export const TRASH_PATH = "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3";

/** The choices of the menu's color grid, in order: `null` for no color, then every marker color. */
export const COLOR_CHOICES: readonly (string | null)[] = [null, ...MARKER_COLORS];

/**
 * The choices of the menu's symbol grid for a project named `name`, in order:
 * `null` for the initials, then every marker icon. A name without a letter has
 * no initials, so its grid starts with the icons.
 */
export function symbolChoices(name: string): readonly (string | null)[] {
  return projectInitials(name) === "" ? MARKER_ICONS : [null, ...MARKER_ICONS];
}

/**
 * The symbol choice the menu marks as current for a project named `name`
 * whose marker icon is `icon`, `null` for the initials: the icon, else the
 * initials, else, for a name without a letter, the fallback icon it shows.
 */
export function currentSymbol(icon: string | null, name: string): string | null {
  return icon ?? (projectInitials(name) === "" ? FALLBACK_ICON : null);
}

/**
 * The index the focus moves to from choice `index` of a grid of `count`
 * choices laid out `columns` per row, on key `key`. Left and right go to the
 * previous and next choice, wrapping from a row end to the next row and from
 * the last choice to the first. Up and down stay in the column, wrapping from
 * one end of the column to the other. Home and End go to the first and last
 * choice. Any other key, or an empty grid, gives `undefined`.
 */
export function gridMove(index: number, count: number, columns: number, key: string): number | undefined {
  if (count <= 0) {
    return undefined;
  }
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "ArrowDown":
      return index + columns < count ? index + columns : index % columns;
    case "ArrowUp": {
      if (index - columns >= 0) {
        return index - columns;
      }
      const column = index % columns;
      const lastRowStart = Math.floor((count - 1) / columns) * columns;
      return lastRowStart + column < count ? lastRowStart + column : lastRowStart + column - columns;
    }
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}

/** Tells whether keyboard event `event` asks for a context menu: Shift+F10 or the menu key. */
export function isMenuKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">): boolean {
  if (event.key === "ContextMenu") {
    return true;
  }
  return event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}
