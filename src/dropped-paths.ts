/** How the paths typed into `claude` are quoted: Windows double quotes, or POSIX single quotes. */
export type PathStyle = "windows" | "posix";

/** The attribute that names the session tab an element belongs to: its tab bar entry or its terminal pane. */
export const TAB_ATTRIBUTE = "data-tab";

/** Characters a Windows path may keep unquoted. */
const WINDOWS_SAFE = /^[A-Za-z0-9_\-.:\\/]+$/;

/** Returns the path style of the system `userAgent` runs on: `"windows"` when it names Windows, else `"posix"`. */
export function pathStyleOf(userAgent: string): PathStyle {
  return userAgent.includes("Windows") ? "windows" : "posix";
}

/** Returns whether `text` holds a C0 or C1 control character, DEL, or a Unicode line or paragraph separator. */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

/**
 * Returns `path` quoted for `claude`'s input in `style`: a Windows path is
 * double-quoted unless it holds only safe characters, a POSIX path is always
 * single-quoted. Returns `undefined` when
 * the path cannot be typed as is: empty, holding a control character, or, in
 * the Windows style, holding a double quote. Such a path is refused whole,
 * never cleaned up, since a cleaned path would name another file.
 */
export function quotePath(path: string, style: PathStyle): string | undefined {
  if (path === "" || hasControlCharacter(path)) {
    return undefined;
  }
  if (style === "windows") {
    if (path.includes('"')) {
      return undefined;
    }
    return WINDOWS_SAFE.test(path) ? path : `"${path}"`;
  }
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Returns `paths` quoted for `claude`'s input in `style` (see {@link quotePath})
 * and joined by a space. Refused paths are left out; returns `""` when none is left.
 */
export function formatPathsForInput(paths: readonly string[], style: PathStyle): string {
  return paths
    .map((path) => quotePath(path, style))
    .filter((quoted) => quoted !== undefined)
    .join(" ");
}

/** What {@link dropTargetTab} needs from an element: its closest ancestor matching a selector. */
export interface DropElement {
  closest(selectors: string): { getAttribute(name: string): string | null } | null;
}

/**
 * Returns the id of the session tab a drop on `element` goes to: the closest
 * element carrying {@link TAB_ATTRIBUTE}, a session tab's bar entry or its
 * terminal pane. Returns `undefined` for `null`, for an element outside both,
 * and for an attribute that is not a whole number.
 */
export function dropTargetTab(element: DropElement | null): number | undefined {
  const value = element?.closest(`[${TAB_ATTRIBUTE}]`)?.getAttribute(TAB_ATTRIBUTE);
  if (value === undefined || value === null || !/^\d+$/.test(value)) {
    return undefined;
  }
  return Number(value);
}
