import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "bump-version.js");

const PACKAGE_JSON = `{
  "name": "demo",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "other": "1.0.0"
  }
}
`;

const CARGO_TOML = [
  "[package]",
  'name = "demo"',
  'version = "0.1.0"',
  'edition = "2021"',
  "",
  "[lib]",
  'path = "lib.rs"',
  "",
].join("\n");

const STALE_LOCK = [
  "version = 4",
  "",
  "[[package]]",
  'name = "demo"',
  'version = "0.1.0"',
  "",
].join("\n");

const MANIFEST = `{
  ".": "0.1.0"
}
`;

let root = "";

/** Builds a throwaway repository holding a copy of the script, package.json, .release-please-manifest.json and src-tauri/Cargo.toml. */
function makeRepo(packageJson = PACKAGE_JSON, cargoToml = CARGO_TOML) {
  root = mkdtempSync(join(tmpdir(), "bump-version-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src-tauri"));
  copyFileSync(script, join(root, "scripts", "bump-version.js"));
  writeFileSync(join(root, "package.json"), packageJson);
  writeFileSync(join(root, ".release-please-manifest.json"), MANIFEST);
  writeFileSync(join(root, "src-tauri", "Cargo.toml"), cargoToml);
  writeFileSync(join(root, "src-tauri", "Cargo.lock"), STALE_LOCK);
  writeFileSync(join(root, "src-tauri", "lib.rs"), "");
}

/** Runs the copied script with `args` and returns its exit status and output. */
function bump(...args) {
  const result = spawnSync(process.execPath, [join(root, "scripts", "bump-version.js"), ...args], {
    encoding: "utf8",
    env: { ...process.env, CARGO_NET_OFFLINE: "true" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Reads `relative` from the throwaway repository. */
function read(relative) {
  return readFileSync(join(root, relative), "utf8");
}

beforeEach(() => {
  makeRepo();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("bump-version", () => {
  it("writes the version into package.json and Cargo.toml and refreshes Cargo.lock", () => {
    const result = bump("1.2.3");

    expect(result.status).toBe(0);
    expect(JSON.parse(read("package.json"))).toEqual({
      ...JSON.parse(PACKAGE_JSON),
      version: "1.2.3",
    });
    expect(read("src-tauri/Cargo.toml")).toBe(CARGO_TOML.replace('version = "0.1.0"', 'version = "1.2.3"'));
    expect(read("src-tauri/Cargo.lock")).toContain('name = "demo"\nversion = "1.2.3"');
    expect(result.stdout).toContain("Version set to 1.2.3");
  }, 60_000);

  it("writes the version into .release-please-manifest.json", () => {
    const result = bump("0.2.0");

    expect(result.status).toBe(0);
    expect(JSON.parse(read(".release-please-manifest.json"))).toEqual({ ".": "0.2.0" });
  }, 60_000);

  it("rewrites only the package version, not a version line further down Cargo.toml", () => {
    rmSync(root, { recursive: true, force: true });
    makeRepo(PACKAGE_JSON, `${CARGO_TOML}\n[package.metadata.demo]\nversion = "9.9.9"\n`);

    const result = bump("2.0.0");

    expect(result.status).toBe(0);
    const cargo = read("src-tauri/Cargo.toml");
    expect(cargo).toContain('[package]\nname = "demo"\nversion = "2.0.0"');
    expect(cargo).toContain('version = "9.9.9"');
  }, 60_000);

  it("keeps the CRLF line endings of Cargo.toml", () => {
    rmSync(root, { recursive: true, force: true });
    const crlf = CARGO_TOML.replaceAll("\n", "\r\n");
    makeRepo(PACKAGE_JSON, crlf);

    const result = bump("0.2.0");

    expect(result.status).toBe(0);
    expect(read("src-tauri/Cargo.toml")).toBe(crlf.replace('version = "0.1.0"', 'version = "0.2.0"'));
  }, 60_000);

  it.each([
    ["no argument", []],
    ["two arguments", ["1.2.3", "1.2.4"]],
    ["a missing patch number", ["1.2"]],
    ["a leading v", ["v1.2.3"]],
    ["a leading zero", ["01.2.3"]],
    ["a pre-release suffix", ["1.2.3-beta"]],
    ["build metadata", ["1.2.3+build"]],
    ["an empty string", [""]],
  ])("refuses %s and leaves every file untouched", (_label, args) => {
    const result = bump(...args);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: pnpm bump-version <X.Y.Z>");
    expect(read("package.json")).toBe(PACKAGE_JSON);
    expect(read(".release-please-manifest.json")).toBe(MANIFEST);
    expect(read("src-tauri/Cargo.toml")).toBe(CARGO_TOML);
    expect(read("src-tauri/Cargo.lock")).toBe(STALE_LOCK);
  });

  it("accepts zero components", () => {
    expect(bump("0.0.0").status).toBe(0);
    expect(JSON.parse(read("package.json")).version).toBe("0.0.0");
  }, 60_000);

  it("fails without touching Cargo.toml when package.json has no version field", () => {
    rmSync(root, { recursive: true, force: true });
    makeRepo('{\n  "name": "demo"\n}\n');

    const result = bump("1.2.3");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no version field found in");
    expect(read("src-tauri/Cargo.toml")).toBe(CARGO_TOML);
  });

  it("fails when Cargo.toml has no version line", () => {
    rmSync(root, { recursive: true, force: true });
    makeRepo(PACKAGE_JSON, CARGO_TOML.replace('version = "0.1.0"\n', ""));

    const result = bump("1.2.3");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no version field found in");
    expect(read("src-tauri/Cargo.lock")).toBe(STALE_LOCK);
    expect(read("package.json")).toBe(PACKAGE_JSON);
  });

  it("leaves package.json, the release manifest, Cargo.toml and Cargo.lock untouched when cargo update fails", () => {
    rmSync(root, { recursive: true, force: true });
    const brokenCargo = `${CARGO_TOML}\n[dependencies]\nmissing = { path = "does-not-exist" }\n`;
    makeRepo(PACKAGE_JSON, brokenCargo);

    const result = bump("1.2.3");

    expect(result.status).not.toBe(0);
    expect(read("package.json")).toBe(PACKAGE_JSON);
    expect(read(".release-please-manifest.json")).toBe(MANIFEST);
    expect(read("src-tauri/Cargo.toml")).toBe(brokenCargo);
    expect(read("src-tauri/Cargo.lock")).toBe(STALE_LOCK);
  }, 60_000);
});
