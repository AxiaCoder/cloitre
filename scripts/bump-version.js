// Usage: pnpm bump-version <X.Y.Z>
// Writes the version into package.json and src-tauri/Cargo.toml, then refreshes src-tauri/Cargo.lock.
// tauri.conf.json reads its version from package.json and needs no change.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");

/**
 * Replaces the first match of `pattern` in the file at `path` with `replacement`.
 * @param {string} path Absolute path of the file to rewrite.
 * @param {RegExp} pattern Pattern whose first match is replaced; the file keeps its line endings.
 * @param {string} replacement Text written in place of the match.
 * @throws {Error} When `pattern` matches nothing in the file.
 */
function replaceFirst(path, pattern, replacement) {
  const content = readFileSync(path, "utf8");
  if (!pattern.test(content)) {
    throw new Error(`no version field found in ${path}`);
  }
  writeFileSync(path, content.replace(pattern, replacement));
}

const version = process.argv[2];
if (process.argv.length !== 3 || version === undefined || !SEMVER.test(version)) {
  process.stderr.write("Usage: pnpm bump-version <X.Y.Z>, for example pnpm bump-version 0.2.0\n");
  process.exit(1);
}

replaceFirst(join(root, "package.json"), /"version": "[^"]*"/, `"version": "${version}"`);
replaceFirst(join(tauriDir, "Cargo.toml"), /^version = "[^"]*"/m, `version = "${version}"`);
execFileSync("cargo", ["update", "--workspace"], { cwd: tauriDir, stdio: "inherit" });

process.stdout.write(`Version set to ${version} in package.json, src-tauri/Cargo.toml and src-tauri/Cargo.lock.\n`);
