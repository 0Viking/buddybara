// Markdown in the chat's answers (src/views/markdown.ts): the block parser
// follows ChatMarkdown.swift, inline syntax is parsed to a tree, and rendering
// builds DOM nodes from text only — never HTML — with http(s)-only links.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, sent } from "./tauri.mjs";

const dom = installFakeDom();
const { fileTarget, parseMarkdown, parseInline, renderMarkdown, safeWebUrl, tableCells } = await import("../src/views/markdown.ts");

beforeEach(() => {
  calls.length = 0;
});

// ── Blocks ────────────────────────────────────────────────────────────────────

test("headings need a space after the hashes", () => {
  assert.deepEqual(parseMarkdown("# Title\n## Sub\n####### Deep"), [
    { kind: "heading", level: 1, text: "Title" },
    { kind: "heading", level: 2, text: "Sub" },
    { kind: "heading", level: 6, text: "Deep" },
  ]);
  assert.deepEqual(parseMarkdown("#hashtag"), [{ kind: "paragraph", text: "#hashtag" }]);
});

test("a fenced code block keeps its lines as they are, language apart", () => {
  const md = "Before\n```python\nprint('hi')\n  indented\n\n# not a heading\n```\nAfter";
  assert.deepEqual(parseMarkdown(md), [
    { kind: "paragraph", text: "Before" },
    { kind: "code", lang: "python", code: "print('hi')\n  indented\n\n# not a heading" },
    { kind: "paragraph", text: "After" },
  ]);
  // An unclosed fence runs to the end, as while an answer is still streaming.
  assert.deepEqual(parseMarkdown("```\nlet x"), [{ kind: "code", lang: "", code: "let x" }]);
});

test("lists keep their markers and nesting", () => {
  assert.deepEqual(parseMarkdown("- one\n* two\n  + nested\n1. first\n12. twelfth"), [
    { kind: "item", prefix: "•", text: "one", indent: 0 },
    { kind: "item", prefix: "•", text: "two", indent: 0 },
    { kind: "item", prefix: "•", text: "nested", indent: 1 },
    { kind: "item", prefix: "1.", text: "first", indent: 0 },
    { kind: "item", prefix: "12.", text: "twelfth", indent: 0 },
  ]);
});

test("quotes, rules and paragraphs that stop at the next block", () => {
  assert.deepEqual(parseMarkdown("> quoted\n>\n---\nline one\nline two\n- item\n\npara"), [
    { kind: "quote", text: "quoted" },
    { kind: "quote", text: "" },
    { kind: "rule" },
    { kind: "paragraph", text: "line one\nline two" },
    { kind: "item", prefix: "•", text: "item", indent: 0 },
    { kind: "paragraph", text: "para" },
  ]);
  assert.deepEqual(parseMarkdown("a\r\nb"), [{ kind: "paragraph", text: "a\nb" }]);
  assert.deepEqual(parseMarkdown(""), []);
});

test("a table: a header row, a delimiter row, then rows until a blank line", () => {
  const md = "Before\n| | What | Effort |\n|---|:---|:-:|\n| F1 | The **menu** | M |\n| F2 | History |\n\nAfter";
  assert.deepEqual(parseMarkdown(md), [
    { kind: "paragraph", text: "Before" },
    {
      kind: "table",
      align: [null, "left", "center"],
      head: ["", "What", "Effort"],
      // A short row is padded to the header's width.
      rows: [["F1", "The **menu**", "M"], ["F2", "History", ""]],
    },
    { kind: "paragraph", text: "After" },
  ]);
  // Outer pipes are optional; a long row is cut to the header's width.
  assert.deepEqual(parseMarkdown("a | b\n--: | ---\n1 | 2 | 3"), [
    { kind: "table", align: ["right", null], head: ["a", "b"], rows: [["1", "2"]] },
  ]);
});

test("table cells keep escaped pipes, pipes in code and <br> line breaks", () => {
  assert.deepEqual(tableCells("| a \\| b | `x || y` | c |"), ["a | b", "`x || y`", "c"]);
  assert.deepEqual(parseMarkdown("| A |\n|---|\n| one<br>two<br/>three |")[0].rows, [["one\ntwo\nthree"]]);
});

test("pipes without a delimiter row are just text", () => {
  assert.deepEqual(parseMarkdown("a | b\nc | d"), [{ kind: "paragraph", text: "a | b\nc | d" }]);
  // A delimiter row with another cell count is no table either.
  assert.deepEqual(parseMarkdown("a | b\n---|---|---"), [{ kind: "paragraph", text: "a | b\n---|---|---" }]);
  assert.deepEqual(parseMarkdown("| x |\n---"), [{ kind: "paragraph", text: "| x |" }, { kind: "rule" }]);
});

// ── Inline ────────────────────────────────────────────────────────────────────

test("inline code, bold, italic and links nest as a tree", () => {
  assert.deepEqual(parseInline("Use `npm ci` **now**, *really* or __not__ _ever_."), [
    { kind: "text", text: "Use " },
    { kind: "code", text: "npm ci" },
    { kind: "text", text: " " },
    { kind: "strong", children: [{ kind: "text", text: "now" }] },
    { kind: "text", text: ", " },
    { kind: "em", children: [{ kind: "text", text: "really" }] },
    { kind: "text", text: " or " },
    { kind: "strong", children: [{ kind: "text", text: "not" }] },
    { kind: "text", text: " " },
    { kind: "em", children: [{ kind: "text", text: "ever" }] },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(parseInline("[**Docs**](https://example.com/a?b=1)"), [
    { kind: "link", url: "https://example.com/a?b=1", children: [{ kind: "strong", children: [{ kind: "text", text: "Docs" }] }] },
  ]);
});

test("snake_case words and code spans are not italics", () => {
  assert.deepEqual(parseInline("call my_long_name now"), [{ kind: "text", text: "call my_long_name now" }]);
  assert.deepEqual(parseInline("`a *b* c`"), [{ kind: "code", text: "a *b* c" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ kind: "text", text: "2 * 3 * 4" }]);
});

test("only http and https addresses become links", () => {
  assert.equal(safeWebUrl("https://example.com"), "https://example.com/");
  assert.equal(safeWebUrl("http://localhost:3000/x"), "http://localhost:3000/x");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "vbscript:x", "/relative", "mailto:a@b.c", "not a url"]) {
    assert.equal(safeWebUrl(bad), null, bad);
  }
  assert.deepEqual(parseInline("[click](javascript:alert(1))"), [
    { kind: "link", url: null, children: [{ kind: "text", text: "click" }] },
    { kind: "text", text: ")" },
  ]);
});

// ── Rendering ─────────────────────────────────────────────────────────────────

test("markup in an answer is shown as text, never parsed", () => {
  const root = dom.root();
  const evil = '<img src=x onerror="alert(1)"> **<script>alert(2)</script>**\n```\n<b>code</b>\n```';
  renderMarkdown(root, evil); // fakedom throws if anything touches innerHTML
  assert.equal(root.find("IMG").length, 0);
  assert.equal(root.find("SCRIPT").length, 0);
  assert.equal(root.find("B").length, 0);
  assert.match(root.textContent, /<img src=x onerror="alert\(1\)">/);
  assert.equal(root.find("STRONG")[0].textContent, "<script>alert(2)</script>");
  assert.equal(root.find("PRE")[0].textContent, "<b>code</b>");
});

test("each block becomes its own element", () => {
  const root = dom.root();
  renderMarkdown(root, "## Answer\n\nHere:\n\n- **item 1**\n- item 2\n\n> note\n\n---\n\n```js\nx()\n```");
  const classes = root.children.map((c) => c.className);
  assert.deepEqual(classes, ["md-h md-h1", "md-p", "md-item", "md-item", "md-quote", "md-rule", "md-pre"]);
  assert.equal(root.find(".md-bullet")[0].textContent, "•");
  assert.equal(root.find(".md-copy").length, 1);
  // Rendering again replaces, it never appends.
  renderMarkdown(root, "plain");
  assert.equal(root.children.length, 1);
});

test("a table becomes a scrolling frame around a table, cells parsed inline", () => {
  const root = dom.root();
  renderMarkdown(root, "| Name | Size |\n|:--|--:|\n| `a.ts` | **12** |\n| b | 3 |");
  assert.deepEqual(root.children.map((c) => c.className), ["md-table"]);
  const th = root.find("TH");
  assert.deepEqual(th.map((c) => c.textContent), ["Name", "Size"]);
  assert.equal(th[0].style.textAlign, "left");
  assert.equal(th[1].style.textAlign, "right");
  const td = root.find("TD");
  assert.deepEqual(td.map((c) => c.textContent), ["a.ts", "12", "b", "3"]);
  assert.equal(root.find("TR").length, 3);
  assert.equal(td[0].find("CODE").length, 1);
  assert.equal(td[1].find("STRONG").length, 1);
});

test("a web link opens through Rust; a file link is shown by Rust; anything else is plain text", () => {
  const root = dom.root();
  renderMarkdown(root, "See [the docs](https://example.com/docs), [the fix](src/main.ts#L12) or [this](javascript:alert(1)).", "C:\\p\\app");
  const links = root.find("A");
  assert.equal(links.length, 2);
  assert.equal(links[0].getAttribute("href"), "https://example.com/docs");
  const event = links[0].fire("click");
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(sent("open_url"), [{ url: "https://example.com/docs" }]);
  links[1].fire("click");
  assert.deepEqual(sent("open_path"), [{ path: "src/main.ts", line: 12, base: "C:\\p\\app" }]);
  assert.match(root.textContent, /or this\)\.$/);
});

test("a link names a file by its path, a file URL or a path with its line", () => {
  assert.deepEqual(fileTarget("src/main.ts#L12-L20"), { path: "src/main.ts", line: 12 });
  assert.deepEqual(fileTarget("src/main.ts:40:7"), { path: "src/main.ts", line: 40 });
  assert.deepEqual(fileTarget("C:\\Users\\me\\notes.txt"), { path: "C:\\Users\\me\\notes.txt", line: null });
  assert.deepEqual(fileTarget("file:///C:/My%20Projects/a.md"), { path: "C:/My Projects/a.md", line: null });
  assert.deepEqual(fileTarget("README.md"), { path: "README.md", line: null });
  for (const not of ["javascript:alert(1)", "mailto:a@b.c", "#anchor", "localhost:3000", "word"]) {
    assert.equal(fileTarget(not), null, not);
  }
});

test("written-out addresses and paths in code are links too", () => {
  assert.deepEqual(parseInline("Filed https://jira.example.com/browse/FORT-12."), [
    { kind: "text", text: "Filed " },
    { kind: "link", url: "https://jira.example.com/browse/FORT-12", children: [{ kind: "text", text: "https://jira.example.com/browse/FORT-12" }] },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(parseInline("(see https://example.com/a_(b))"), [
    { kind: "text", text: "(see " },
    { kind: "link", url: "https://example.com/a_(b)", children: [{ kind: "text", text: "https://example.com/a_(b)" }] },
    { kind: "text", text: ")" },
  ]);
  assert.deepEqual(parseInline("Saved C:\\Users\\me\\Desktop\\clear.bat, done"), [
    { kind: "text", text: "Saved " },
    { kind: "link", url: null, file: { path: "C:\\Users\\me\\Desktop\\clear.bat", line: null }, children: [{ kind: "text", text: "C:\\Users\\me\\Desktop\\clear.bat" }] },
    { kind: "text", text: ", done" },
  ]);
  assert.deepEqual(parseInline("`src/core/theme.ts:42`"), [{ kind: "code", text: "src/core/theme.ts:42", file: { path: "src/core/theme.ts", line: 42 } }]);
  assert.deepEqual(parseInline("`C:\\My Projects\\notes`"), [{ kind: "code", text: "C:\\My Projects\\notes", file: { path: "C:\\My Projects\\notes", line: null } }]);
  assert.deepEqual(parseInline("`https://localhost:5173`"), [{ kind: "code", text: "https://localhost:5173", url: "https://localhost:5173/" }]);
  // Commands and bare names stay code.
  assert.deepEqual(parseInline("`npm run build` and `theme.ts`"), [
    { kind: "code", text: "npm run build" },
    { kind: "text", text: " and " },
    { kind: "code", text: "theme.ts" },
  ]);
});
