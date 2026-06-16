// Headless tests for the desktop renderer's pure rendering/security functions.
// Runs the REAL <script> from desktop/renderer.html in a vm under a DOM stub (no drift), then
// asserts the XSS/math/CSV/list behaviour. DOMPurify/SVG sanitization needs a real DOM, so that
// path is verified live in Electron — see the loop notes. Run: `node scripts/test-renderer.mjs`.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "desktop/renderer.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const code = scripts[scripts.length - 1];

// Universal DOM stub: every access returns a callable stub; querySelectorAll yields [].
const mk = () =>
  new Proxy(function () {}, {
    get(t, p) {
      if (p === "querySelectorAll") return () => [];
      if (p === Symbol.iterator) return undefined;
      if (p === "length") return 0;
      return mk();
    },
    apply() { return mk(); },
    construct() { return mk(); },
    set() { return true; },
  });
const doc = { getElementById: () => mk(), createElement: () => mk(), querySelector: () => mk(),
  querySelectorAll: () => [], addEventListener: () => {}, body: mk(), head: mk(), documentElement: mk() };
const win = { katex: { renderToString: (tex, o) => "⟦KX" + (o && o.displayMode ? "D" : "I") + ":" + tex + "⟧" },
  renderMathInElement: () => {}, DOMPurify: null, mermaid: null, addEventListener: () => {},
  location: { href: "file:///x/" }, matchMedia: () => ({ matches: false, addEventListener: () => {} }) };
const ctx = { window: win, document: doc, navigator: { clipboard: { writeText: () => Promise.resolve() }, platform: "Mac" },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: win.location,
  setTimeout: () => 0, setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {}, console,
  URL, DOMParser: function () { this.parseFromString = () => ({ querySelector: () => null, documentElement: { tagName: "svg" }, querySelectorAll: () => [] }); },
  XMLSerializer: function () { this.serializeToString = () => "<svg></svg>"; }, requestAnimationFrame: () => 0 };
ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
try { vm.runInContext(code, ctx, { filename: "renderer.js" }); } catch { /* top-level DOM use throws after fn hoist */ }

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log("✗ FAIL:", name); } };
const { esc, safeUrl, mdToHtml, parseCsv, buildNestedList, texToHtml } = ctx;
ok("functions hoisted", [esc, safeUrl, mdToHtml, parseCsv, buildNestedList].every((f) => typeof f === "function"));

// esc escapes quotes (attribute-breakout fix)
ok("esc quotes", esc('a"b\'c<>&') === "a&quot;b&#39;c&lt;&gt;&amp;");

// safeUrl: block script schemes, allow safe ones
ok("safeUrl javascript blocked", safeUrl("javascript:alert(1)") === "#");
ok("safeUrl js spaced blocked", safeUrl("  java\tscript:alert(1)") === "#");
ok("safeUrl vbscript blocked", safeUrl("vbscript:x") === "#");
ok("safeUrl data non-image blocked", safeUrl("data:text/html,<x>") === "#");
ok("safeUrl data image ok", safeUrl("data:image/png;base64,AAA") === "data:image/png;base64,AAA");
ok("safeUrl http ok", safeUrl("https://a.com/x") === "https://a.com/x");
ok("safeUrl relative ok", safeUrl("images/x.png") === "images/x.png");

// attribute-breakout / javascript link neutralized
const xss = mdToHtml('![x](z" onerror="alert(1))');
ok("img breakout neutralized", !/ onerror="alert/.test(xss));
const jsl = mdToHtml("[click](javascript:alert(1))");
ok("link javascript neutralized", !/href="javascript:/.test(jsl) && /href="#"/.test(jsl));

// math: NUL sentinel — prose digits intact, currency intact, math rendered with subscripts
ok("prose digits intact", (() => { const m = mdToHtml("I have 5 apples and 12 oranges"); return m.includes("5 apples") && m.includes("12 oranges"); })());
ok("currency not math", (() => { const m = mdToHtml("It costs $5 and $10 total"); return m.includes("$5") && m.includes("$10") && !m.includes("⟦KX"); })());
ok("paren math rendered + subscript kept", (() => { const m = mdToHtml("inline \\(R_{t-1}\\) here"); return m.includes("⟦KXI:R_{t-1}⟧") && !/<em>/.test(m); })());
ok("dollar inline math rendered", mdToHtml("eq $x_i$ end").includes("⟦KXI:x_i⟧"));
ok("block display math", (() => { const m = mdToHtml("$$\n a = b \\\\\n c = d \n$$"); return m.includes("⟦KXD:") && m.includes("mathblock"); })());

// CSV: RFC-4180 multiline + escaped quotes
const rows = parseCsv('id,desc\n1,"line one\nline two"\n2,ok');
ok("csv row count", rows.length === 3);
ok("csv multiline cell", rows[1][1] === "line one\nline two");
ok("csv escaped quote", parseCsv('a,"x""y"')[0][1] === 'x"y');

// Nested list: child <ul> nested INSIDE parent <li>, balanced tags
const nl = buildNestedList([{ indent: 0, ordered: false, task: null, text: "A" }, { indent: 2, ordered: false, task: null, text: "B" }, { indent: 0, ordered: false, task: null, text: "C" }], (t) => t);
ok("nested list valid (ul inside li)", nl.includes("<li>A<ul><li>B</li></ul></li>") && nl.includes("<li>C</li>"));
ok("nested list balanced", (nl.match(/<ul>/g) || []).length === (nl.match(/<\/ul>/g) || []).length && (nl.match(/<li/g) || []).length === (nl.match(/<\/li>/g) || []).length);

// task checkboxes
const tl = buildNestedList([{ indent: 0, ordered: false, task: true, text: "done" }, { indent: 0, ordered: false, task: false, text: "todo" }], (t) => t);
ok("task list checkboxes", tl.includes('type="checkbox" disabled checked') && tl.includes('class="task"'));

// tex renders without throwing
ok("tex renders", typeof texToHtml("\\begin{document}\ninline $a_i$ text\n\\[ b^2 \\]\n\\end{document}") === "string");

// interactive-HTML self-containment detection (multi-file → static; self-contained → sandboxed JS)
const needsLocal = ctx.htmlNeedsLocalFiles;
ok("htmlNeedsLocalFiles defined", typeof needsLocal === "function");
ok("self-contained inline", needsLocal("<html><script>x()</script><style>a{}</style></html>") === false);
ok("cdn = self-contained", needsLocal('<script src="https://cdn/x.js"></script>') === false);
ok("relative js = needs local", needsLocal('<script src="app.js"></script>') === true);
ok("relative css = needs local", needsLocal('<link rel="stylesheet" href="style.css">') === true);
ok("relative img = needs local", needsLocal('<img src="pics/a.png">') === true);
ok("data uri = self-contained", needsLocal('<img src="data:image/png;base64,AA">') === false);

// table cells: escaped \| and pipes inside `code` must NOT create extra columns
const tbl = mdToHtml("| 식 | 결과 |\n|----|----|\n| `a \\| b` | OR |\n| c \\| d | esc |");
ok("table 2 data cells per row (pipe-safe)", (tbl.match(/<td>/g) || []).length === 4);
ok("table code-pipe kept in one cell", /<td><code>a \| b<\/code><\/td>/.test(tbl));
ok("table escaped-pipe literal", /<td>c \| d<\/td>/.test(tbl));

// GFM column alignment from the separator row
const at = mdToHtml("| L | C | R |\n|:---|:---:|---:|\n| a | b | c |");
ok("table align left", /<th style="text-align:left">L<\/th>/.test(at));
ok("table align center", /text-align:center">C<\/th>/.test(at) && /text-align:center">b<\/td>/.test(at));
ok("table align right", /text-align:right">R<\/th>/.test(at) && /text-align:right">c<\/td>/.test(at));
ok("table wrapped in scroll container", /<div class="tablewrap"><table>/.test(at));

// bare-URL autolinking (without double-linking existing links or code-span URLs)
ok("autolink bare url", /<a href="https:\/\/example\.com">https:\/\/example\.com<\/a>/.test(mdToHtml("방문 https://example.com 하세요")));
ok("autolink trailing punct outside link", /<a href="https:\/\/ex\.com">https:\/\/ex\.com<\/a>\./.test(mdToHtml("see https://ex.com.")));
ok("existing md link not double-linked", (mdToHtml("[x](https://y.com)").match(/<a /g) || []).length === 1);
ok("url in code span not autolinked", !/<code><a/.test(mdToHtml("`https://incode.com`")));

ok("mdToHtml strips leading BOM (heading renders)", /<h1>제목<\/h1>/.test(mdToHtml("\uFEFF# 제목")));

// blockquote: nested quotes + internal structure (list, multi-paragraph) preserved
const bq = mdToHtml("> outer\n> > inner");
ok("nested blockquote", /<blockquote>[\s\S]*<blockquote>[\s\S]*inner[\s\S]*<\/blockquote>[\s\S]*<\/blockquote>/.test(bq));
const bql = mdToHtml("> note\n>\n> - one\n> - two");
ok("blockquote contains list", /<blockquote>[\s\S]*<ul>[\s\S]*one[\s\S]*<\/ul>[\s\S]*<\/blockquote>/.test(bql));
ok("blockquote multi-paragraph", (mdToHtml("> p1\n>\n> p2").match(/<p>/g) || []).length >= 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
