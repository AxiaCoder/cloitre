import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { clipboardFilePaths, clipboardPaste } from "./clipboard";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("clipboardFilePaths", () => {
  it("asks Rust for the copied files, without arguments", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([String.raw`C:\a.txt`]);
    await expect(clipboardFilePaths()).resolves.toEqual([String.raw`C:\a.txt`]);
    expect(vi.mocked(invoke).mock.calls).toEqual([["clipboard_file_paths"]]);
  });
});

describe("clipboardPaste", () => {
  it("types the copied files' paths, quoted and joined as a drop", () => {
    expect(clipboardPaste([String.raw`C:\a.txt`, String.raw`C:\my file.md`], undefined, "windows")).toEqual({
      text: String.raw`C:\a.txt "C:\my file.md"`,
    });
  });

  it("prefers the copied files to the image key", () => {
    expect(clipboardPaste(["/tmp/photo.png"], "\x16", "posix")).toEqual({ text: "'/tmp/photo.png'" });
  });

  it("sends the image key when no file was copied", () => {
    expect(clipboardPaste([], "\x1bv", "windows")).toEqual({ key: "\x1bv" });
  });

  it("sends nothing without copied file nor image", () => {
    expect(clipboardPaste([], undefined, "windows")).toBeUndefined();
  });

  it("sends nothing, not the image key, when every copied path is refused", () => {
    expect(clipboardPaste(['C:\\bad"name.png'], "\x1bv", "windows")).toBeUndefined();
  });
});
