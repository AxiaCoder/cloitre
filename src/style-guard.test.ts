import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(SRC, "..");

/** The only rules allowed to use the amber tokens: a session is waiting. */
const AMBER_SELECTORS = new Set([".tab .waiting-dot"]);

/** The only file allowed to hold color literals. */
const TOKENS_FILE = "src/tokens.css";

const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
    "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
    "darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
    "darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
    "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
    "ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
    "lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
    "mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
    "mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab " +
    "orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
    "pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan " +
    "teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

/** A CSS rule: where it was found, its selector and its declarations. */
interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Splits CSS `text` into its innermost rules, comments removed; at-rule wrappers drop out. */
function cssRules(file: string, text: string): Rule[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/gu)].map((match) => ({
    file,
    selector: match[1].trim().replace(/\s+/gu, " "),
    body: match[2],
  }));
}

/** The rules of an HTML page: its `<style>` blocks and every `style` attribute. */
function htmlRules(file: string, html: string): Rule[] {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/giu)].flatMap((match) =>
    cssRules(file, match[1]),
  );
  const attributes = [...html.matchAll(/\sstyle\s*=\s*(["'])(.*?)\1/gisu)].map((match) => ({
    file,
    selector: "[style attribute]",
    body: match[2],
  }));
  return [...blocks, ...attributes];
}

/** Tells whether `text` uses `--accent` or `--accent-ink` through `var()`. */
function usesAmber(text: string): boolean {
  return /var\(\s*--accent(-ink)?\s*[,)]/u.test(text);
}

/** The color literals in CSS declarations `body`: hex, color functions and named colors. */
function cssColorLiterals(body: string): string[] {
  const unquoted = body.replace(/"[^"]*"|'[^']*'/gu, "");
  const hex = unquoted.match(/#[0-9a-f]{3,8}\b/giu) ?? [];
  const functions = unquoted.match(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/giu) ?? [];
  const named = (unquoted.match(/(?<![\w-])[a-z]+(?![\w-])/giu) ?? []).filter((word) =>
    NAMED_COLORS.has(word.toLowerCase()),
  );
  return [...hex, ...functions, ...named];
}

/** The color literals in TypeScript `source`: quoted hex colors and color functions. */
function tsColorLiterals(source: string): string[] {
  const hex = source.match(/["'`]#[0-9a-f]{3,8}["'`]/giu) ?? [];
  const functions = source.match(/\b(rgba?|hsla?|hwb|oklab|oklch)\(/giu) ?? [];
  return [...hex, ...functions];
}

/** Every file under `dir` whose name ends with `suffix`, as paths relative to the repository root. */
function filesUnder(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(suffix))
    .map((name) => relative(ROOT, join(dir, name)).replace(/\\/gu, "/"));
}

/** Reads `file`, a path relative to the repository root. */
function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

/** Every CSS rule of the app: the stylesheets under `src` and `index.html`. */
function appRules(): Rule[] {
  return [
    ...filesUnder(SRC, ".css").flatMap((file) => cssRules(file, read(file))),
    ...htmlRules("index.html", read("index.html")),
  ];
}

/** The TypeScript sources of the app, tests left out. */
function appSources(): string[] {
  return filesUnder(SRC, ".ts").filter((file) => !file.endsWith(".test.ts"));
}

/** Where `rules` use amber outside a rule for a waiting session, as `file: selector`. */
function amberMisuses(rules: Rule[]): string[] {
  return rules
    .filter((rule) => usesAmber(rule.body) && !AMBER_SELECTORS.has(rule.selector))
    .map((rule) => `${rule.file}: ${rule.selector}`);
}

/** The color literals `rules` hold outside the tokens file, as `file: selector: literal`. */
function strayCssColors(rules: Rule[]): string[] {
  return rules
    .filter((rule) => rule.file !== TOKENS_FILE)
    .flatMap((rule) => cssColorLiterals(rule.body).map((literal) => `${rule.file}: ${rule.selector}: ${literal}`));
}

describe("the guard itself", () => {
  it("catches amber used by any rule but the waiting one", () => {
    const rules = cssRules(
      "sample.css",
      ".tab .waiting-dot { background: var(--accent); }\n" +
        "@media (max-width: 10px) { .project { color: var( --accent-ink ); } }\n" +
        ".primary { border-color: var(--accent, red); }\n" +
        ":root { --accent: x; --accented: y; }\n" +
        ".ok { color: var(--accented); }",
    );
    expect(amberMisuses(rules)).toEqual(["sample.css: .project", "sample.css: .primary"]);
  });

  it("catches amber in a style attribute", () => {
    expect(amberMisuses(htmlRules("page.html", '<p style="color: var(--accent)">'))).toEqual([
      "page.html: [style attribute]",
    ]);
  });

  it("catches color literals but not ids, quoted text or token names", () => {
    expect(cssColorLiterals("color: #fff; background: rgba(0, 0, 0, 0.5); border: 1px solid Red;")).toEqual([
      "#fff",
      "rgba(",
      "Red",
    ]);
    expect(
      cssColorLiterals('color: var(--ink-0); content: "black"; animation: x 1s ease-in-out; border-color: transparent;'),
    ).toEqual([]);
  });

  it("catches quoted hex colors and color functions in TypeScript", () => {
    expect(tsColorLiterals('const a = "#000000"; const b = `rgb(1, 2, 3)`; const c = `#${id}`;')).toEqual([
      '"#000000"',
      "rgb(",
    ]);
  });
});

describe("amber guard", () => {
  it("finds the waiting rule in the stylesheets", () => {
    const selectors = appRules().map((rule) => rule.selector);
    for (const selector of AMBER_SELECTORS) {
      expect(selectors).toContain(selector);
    }
  });

  it("keeps amber for a waiting session", () => {
    expect(amberMisuses(appRules())).toEqual([]);
  });

  it("keeps amber out of the TypeScript", () => {
    expect(appSources().filter((file) => usesAmber(read(file)))).toEqual([]);
  });

  it("keeps color literals in the tokens file", () => {
    expect(strayCssColors(appRules())).toEqual([]);
  });

  it("keeps color literals out of the TypeScript", () => {
    expect(appSources().flatMap((file) => tsColorLiterals(read(file)).map((literal) => `${file}: ${literal}`))).toEqual(
      [],
    );
  });
});
