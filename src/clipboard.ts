import { invoke } from "@tauri-apps/api/core";
import { formatPathsForInput, type PathStyle } from "./dropped-paths";

/**
 * Asks Rust for the full paths of the files copied to the system clipboard
 * (a file manager's Copy), in the clipboard's order. Resolves to an empty
 * list when the clipboard holds no file list, and always outside Windows.
 */
export function clipboardFilePaths(): Promise<string[]> {
  return invoke<string[]>("clipboard_file_paths");
}

/**
 * What a paste without text sends to the session: `{ text }` to type as a
 * paste, `{ key }` to send as a key press, or `undefined` for nothing.
 */
export type ClipboardPaste = { readonly text: string } | { readonly key: string } | undefined;

/**
 * Returns what a paste without text sends to the session, given the `paths`
 * of the files copied to the clipboard and the `imageKey` of the paste (see
 * `imagePasteKey`). Copied files win: their paths, quoted in `style` and
 * joined as a drop is (see {@link formatPathsForInput}), even when the paste
 * also holds an image; nothing when every path is refused. Without copied
 * files, the image key, or nothing when there is none.
 */
export function clipboardPaste(
  paths: readonly string[],
  imageKey: string | undefined,
  style: PathStyle,
): ClipboardPaste {
  if (paths.length > 0) {
    const text = formatPathsForInput(paths, style);
    return text === "" ? undefined : { text };
  }
  return imageKey === undefined ? undefined : { key: imageKey };
}
