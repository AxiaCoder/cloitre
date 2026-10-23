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

/**
 * Splits CSS `text` into its rules in document order, comments removed. Every block is a rule,
 * nested ones and at-rule wrappers included; its body holds only its own declarations, never those
 * of the blocks nested in it.
 */
function cssRules(file: string, text: string): Rule[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: Rule[] = [];
  const open: Rule[] = [];
  let pending = "";
  for (const char of css) {
    if (char === "{") {
      const split = pending.lastIndexOf(";") + 1;
      const parent = open[open.length - 1] as Rule | undefined;
      if (parent) parent.body += pending.slice(0, split);
      const rule = { file, selector: pending.slice(split).trim().replace(/\s+/gu, " "), body: "" };
      rules.push(rule);
      open.push(rule);
      pending = "";
    } else if (char === "}") {
      const rule = open.pop();
      if (rule) rule.body += pending;
      pending = "";
    } else {
      pending += char;
    }
  }
  return rules;
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
  return [...hex, ...functions, ...namedColors(unquoted)];
}

/** The CSS named colors written in `text`, as whole words; custom property names do not count. */
function namedColors(text: string): string[] {
  return (text.match(/(?<![\w-])[a-z]+(?![\w-])/giu) ?? []).filter((word) => NAMED_COLORS.has(word.toLowerCase()));
}

/** The contents of the string literals of TypeScript `source`, quotes removed; comments are skipped. */
function tsStrings(source: string): string[] {
  const tokens = source.matchAll(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/gu,
  );
  return [...tokens].map(([token]) => token).filter((token) => !token.startsWith("/")).map((token) => token.slice(1, -1));
}

/** The values TypeScript `source` gives to a style property: `.style.x = "…"` and `setProperty(…, "…")`. */
function tsStyleValues(source: string): string[] {
  const assigned = [...source.matchAll(/\.style\.\w+\s*=\s*(["'`])(.*?)\1/gu)].map((match) => match[2]);
  const set = [...source.matchAll(/\.setProperty\(\s*(["'`]).*?\1\s*,\s*(["'`])(.*?)\2/gu)].map((match) => match[3]);
  return [...assigned, ...set];
}

/**
 * The color literals in TypeScript `source`: hex colors anywhere inside a string literal, color
 * functions anywhere, and named colors in a value given to a style property.
 */
function tsColorLiterals(source: string): string[] {
  const hex = tsStrings(source).flatMap((content) => content.match(/#[0-9a-f]{3,8}\b/giu) ?? []);
  const functions = source.match(/\b(rgba?|hsla?|hwb|oklab|oklch)\(/giu) ?? [];
  const named = tsStyleValues(source).flatMap(namedColors);
  return [...hex, ...functions, ...named];
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

  it("inspects the declarations of a rule that has nested rules", () => {
    const rules = cssRules("sample.css", ".a { color: #123456; &:hover { opacity: 1; } border: 0 solid red; }");
    expect(strayCssColors(rules)).toEqual(["sample.css: .a: #123456", "sample.css: .a: red"]);
    expect(amberMisuses(cssRules("sample.css", ".tab .waiting-dot { &:hover { color: var(--accent); } }"))).toEqual([
      "sample.css: &:hover",
    ]);
  });

  it("catches hex colors and color functions in TypeScript", () => {
    expect(tsColorLiterals('const a = "#000000"; const b = `rgb(1, 2, 3)`; const c = `#${id}`;')).toEqual([
      "#000000",
      "rgb(",
    ]);
  });

  it("catches a hex color anywhere inside a TypeScript string", () => {
    expect(tsColorLiterals("const a = \"1px solid #ff0000\"; const b = '#000000 '; const c = `x ${y} #abc`;")).toEqual(
      ["#ff0000", "#000000", "#abc"],
    );
  });

  it("catches a named color given to a style property in TypeScript", () => {
    expect(
      tsColorLiterals('el.style.color = "red"; el.style.setProperty("--x", "1px solid White");'),
    ).toEqual(["red", "White"]);
  });

  it("leaves TypeScript comments and prose strings alone", () => {
    expect(
      tsColorLiterals(
        '// see #20 and #abc\n/* #123456 */\nconst a = "A tan coat on a white wall"; el.style.width = "var(--tan)";',
      ),
    ).toEqual([]);
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
