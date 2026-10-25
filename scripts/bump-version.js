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
 * Returns `content` with the first match of `pattern` replaced by `replacement`; line endings are kept.
 * @param {string} content Text of the file at `path`.
 * @param {string} path Path of the file, named in the error.
 * @param {RegExp} pattern Pattern whose first match is replaced.
 * @param {string} replacement Text put in place of the match.
 * @throws {Error} When `pattern` matches nothing in `content`.
 */
function replaceFirst(content, path, pattern, replacement) {
  if (!pattern.test(content)) {
    throw new Error(`no version field found in ${path}`);
  }
  return content.replace(pattern, replacement);
}

const version = process.argv[2];
if (process.argv.length !== 3 || version === undefined || !SEMVER.test(version)) {
  process.stderr.write("Usage: pnpm bump-version <X.Y.Z>, for example pnpm bump-version 0.2.0\n");
  process.exit(1);
}

const packagePath = join(root, "package.json");
const cargoPath = join(tauriDir, "Cargo.toml");
const lockPath = join(tauriDir, "Cargo.lock");
const originals = new Map([packagePath, cargoPath, lockPath].map((path) => [path, readFileSync(path, "utf8")]));

const bumpedPackage = replaceFirst(originals.get(packagePath), packagePath, /"version": "[^"]*"/, `"version": "${version}"`);
const bumpedCargo = replaceFirst(originals.get(cargoPath), cargoPath, /^version = "[^"]*"/m, `version = "${version}"`);

writeFileSync(packagePath, bumpedPackage);
writeFileSync(cargoPath, bumpedCargo);
try {
  execFileSync("cargo", ["update", "--workspace"], { cwd: tauriDir, stdio: "inherit" });
} catch (error) {
  for (const [path, content] of originals) {
    writeFileSync(path, content);
  }
  process.stderr.write("cargo update failed; package.json, Cargo.toml and Cargo.lock are back to their previous content.\n");
  throw error;
}

process.stdout.write(`Version set to ${version} in package.json, src-tauri/Cargo.toml and src-tauri/Cargo.lock.\n`);
