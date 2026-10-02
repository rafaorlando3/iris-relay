// The full UI that IRIS serves from the IPM package (web/relay) is built from the
// same sources as the Node version and must not drift from them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  buildIrisUI,
  outdated,
  packageVersion,
  CSP,
} from "../scripts/build-iris-ui.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("web/relay matches a fresh build of public/ and the root modules", () => {
  const { changed, stray } = outdated();
  assert.deepEqual(changed, [], "run npm run build:iris");
  assert.deepEqual(stray, []);
  const files = readdirSync(new URL("web/relay/", root)).sort();
  for (const name of ["index.html", "lite.html", "app.js", "iris-api.js", "routes.js", "management.js", "configuration.js", "audit.js", "explorer.js", "resources.js", "style.css"])
    assert.ok(files.includes(name), name);
});

test("IRIS-served index: IRIS mode, strict CSP, no inline script, ASCII only, sign-in off until checked", () => {
  const html = read("web/relay/index.html");
  assert.match(html, /<html lang="en" data-mode="iris">/);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}" />`));
  assert.match(CSP, /script-src 'self';/);
  assert.match(CSP, /connect-src 'self';/);
  assert.doesNotMatch(CSP, /unsafe/);
  assert.match(html, /<meta name="referrer" content="no-referrer" \/>/);
  for (const tag of html.match(/<script[^>]*>/g)) assert.match(tag, / src="\.\/app\.js\?v=/);
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.doesNotMatch(html, /style="/);
  assert.doesNotMatch(html, /[^\x00-\x7f]/);
  assert.match(html, /<button class="primary" type="submit" disabled>/);
  assert.match(html, /href="\.\/lite\.html"/);
  assert.doesNotMatch(html, /server memory/);
});

test("every module import in the IRIS UI resolves inside web/relay with the package version", () => {
  const version = packageVersion();
  const built = buildIrisUI();
  for (const [name, content] of built) {
    if (!name.endsWith(".js")) continue;
    assert.doesNotMatch(content, /localStorage|sessionStorage|indexedDB|document\.cookie/, name);
    for (const [, spec] of content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
      const m = spec.match(/^\.\/([A-Za-z0-9_.-]+)\?v=([0-9.]+)$/);
      assert.ok(m, `${name} imports ${spec}`);
      assert.ok(built.has(m[1]), `${name} imports missing ${m[1]}`);
      assert.equal(m[2], version);
    }
  }
});

test("package metadata: one version, static-only /relay application, Relay Lite kept", () => {
  const xml = read("module.xml");
  const version = packageVersion();
  assert.equal(JSON.parse(read("package.json")).version, version);
  assert.match(xml, /<FileCopy Name="web\/relay\/" Target="\$\{cspdir\}relay\/"\/>/);
  const app = xml.match(/<WebApplication\s+Url="\/relay"[^>]*\/>/s)?.[0];
  assert.ok(app, "the /relay web application is declared");
  for (const attr of ['ServeFiles="1"', 'CSPZENEnabled="0"', 'AutoCompile="0"', 'AutheEnabled="64"'])
    assert.ok(app.includes(attr), attr);
  assert.doesNotMatch(app, /DispatchClass/);
  const lite = read("web/relay/lite.html");
  assert.match(lite, /<title>IRIS Relay Lite<\/title>/);
  assert.match(lite, /href="\.\/index\.html"/);
});
