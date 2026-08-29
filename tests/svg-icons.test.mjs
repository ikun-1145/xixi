import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const iconsCssPath = join(root, "p/css/icons.css");
const excludedRoots = new Set([".git", "node_modules", "tests", "docs", "supabase", "workers"]);

function productionUiSources(directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory() && excludedRoots.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionUiSources(path);
    return [".html", ".js", ".css"].includes(extname(entry.name)) ? [path] : [];
  });
}

function withoutNonUiText(source) {
  return source
    .replace(/<!--[^]*?-->/g, "")
    .replace(/\/\*[^]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+\/\/.*$/gm, "")
    .replace(/^\s*console\.[^\n]*$/gm, "");
}

function pictographs(source) {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  return [...segmenter.segment(source)]
    .map(item => item.segment)
    .filter(segment => segment !== "©" && /\p{Extended_Pictographic}/u.test(segment));
}

test("production UI contains no hard-coded emoji glyphs", () => {
  const findings = [];
  for (const path of productionUiSources()) {
    if (path.includes(`${join("p", "vendor")}${process.platform === "win32" ? "\\" : "/"}`)) continue;
    const source = withoutNonUiText(readFileSync(path, "utf8"));
    const matches = [...new Set(pictographs(source))];
    if (matches.length) findings.push(`${relative(root, path)}: ${matches.join(" ")}`);
  }
  assert.deepEqual(findings, []);
});

test("local SVG icon masks resolve to safe local files", () => {
  const css = readFileSync(iconsCssPath, "utf8");
  const files = [...css.matchAll(/url\("\.\.\/icons\/([^"?#]+\.svg)"\)/g)]
    .map(match => match[1]);

  assert.ok(files.length >= 40, "expected the shared local icon set");
  assert.equal(new Set(files).size, files.length, "each icon asset should have one CSS mapping");

  for (const file of files) {
    const path = join(root, "p/icons", file);
    assert.equal(existsSync(path), true, `missing SVG icon: ${file}`);
    const svg = readFileSync(path, "utf8");
    assert.match(svg, /^<svg[\s>]/);
    assert.doesNotMatch(svg, /<script\b|\bon\w+\s*=/i);
  }
});

test("icon source and license are kept with the downloaded assets", () => {
  assert.equal(existsSync(join(root, "p/icons/README.md")), true);
  assert.equal(existsSync(join(root, "p/icons/LICENSE")), true);
});
