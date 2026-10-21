// The buddy panel's conversations (src/buddy/run.ts): what a `claude -p` run
// streams (src-tauri/src/code.rs `events`) turns into the lines it shows.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTACHMENTS, MAX_PROMPT, ago, applyRunEvent, dropQueue, folderOf, lineOf, makeChat, mergeQueued, pastedName,
  sentLength, splitAttachments, takeQueue, tokensShort, tooBig,
} from "../src/buddy/run.ts";

const chat = () => makeChat({ name: "p", path: "C:\\p", sessions: 0, last: 0 }, null, "");

test("a run's stream becomes the conversation's lines", () => {
  const c = chat();
  c.lines.push({ role: "user", text: "fix it" });
  applyRunEvent(c, { run: 1, kind: "init", session: "s1" });
  applyRunEvent(c, { run: 1, kind: "text", text: "Looking." });
  applyRunEvent(c, { run: 1, kind: "tool", tool: "Bash", input: { command: "npm test" } });
  applyRunEvent(c, { run: 1, kind: "text", text: "Fixed." });
  applyRunEvent(c, { run: 1, kind: "text", text: "All green." });
  // The result repeats the last answer: it is not drawn twice.
  applyRunEvent(c, { run: 1, kind: "result", text: "All green.", error: false, session: "s1" });
  assert.equal(c.id, "s1");
  assert.deepEqual(c.lines, [
    { role: "user", text: "fix it" },
    { role: "assistant", text: "Looking." },
    { role: "step", text: "Runs · npm test" },
    { role: "assistant", text: "Fixed.\n\nAll green." },
  ]);
});

test("a message sent as the answer ends doesn't make the result repeat that answer", () => {
  const c = chat();
  c.lines.push({ role: "user", text: "fix it" });
  applyRunEvent(c, { run: 1, kind: "text", text: "Fixed." });
  c.lines.push({ role: "user", text: "and the docs" });
  applyRunEvent(c, { run: 1, kind: "result", text: "Fixed.", error: false });
  // Read as one more turn of the same run.
  applyRunEvent(c, { run: 1, kind: "text", text: "Docs too." });
  applyRunEvent(c, { run: 1, kind: "result", text: "Docs too.", error: false });
  assert.deepEqual(c.lines.map((l) => l.text), ["fix it", "Fixed.", "and the docs", "Docs too."]);
});

test("a run that fails ends on its error", () => {
  const c = chat();
  applyRunEvent(c, { run: 1, kind: "result", text: "Not logged in", error: true });
  assert.deepEqual(c.lines, [{ role: "error", text: "Not logged in" }]);
  assert.equal(c.failed, true);
  applyRunEvent(c, { run: 2, kind: "result", text: "Done.", error: false });
  assert.equal(c.failed, false);
});

test("a conversation read back from its file reads like the live run, steps and files included", () => {
  const sent = "what is on this?\n\nAttached files:\n- C:\\Buddybara\\inbox\\shot.png\n- C:\\Buddybara\\inbox\\notes (2).txt";
  assert.deepEqual(
    [
      { role: "user", text: sent },
      { role: "assistant", text: "Let me look." },
      { role: "step", text: "", tool: "Read", input: { file_path: "C:\\Buddybara\\inbox\\shot.png" } },
      { role: "step", text: "", tool: "SomethingNew", input: {} },
    ].map(lineOf),
    [
      { role: "user", text: "what is on this?", files: ["C:\\Buddybara\\inbox\\shot.png", "C:\\Buddybara\\inbox\\notes (2).txt"] },
      { role: "assistant", text: "Let me look." },
      { role: "step", text: "Reads · shot.png" },
      { role: "step", text: "SomethingNew" },
    ],
  );
});

test("compacting shows while it runs, then how big the conversation was", () => {
  const c = chat();
  c.lines.push({ role: "user", text: "hi" }, { role: "assistant", text: "Hello." }, { role: "user", text: "/compact" });
  applyRunEvent(c, { run: 1, kind: "compacting" });
  // Said twice, it is still one line.
  applyRunEvent(c, { run: 1, kind: "compacting" });
  assert.deepEqual(c.lines.slice(3), [{ role: "compacting", text: "" }]);
  applyRunEvent(c, { run: 1, kind: "compacted", tokens: 73870 });
  applyRunEvent(c, { run: 1, kind: "result", text: "" });
  assert.deepEqual(c.lines.slice(3), [{ role: "compacted", text: "", tokens: 73870 }]);

  // When the context fills mid-turn: the answer before the compaction isn't repeated by the result.
  const auto = chat();
  auto.lines.push({ role: "user", text: "go" });
  applyRunEvent(auto, { run: 1, kind: "text", text: "Working on it." });
  applyRunEvent(auto, { run: 1, kind: "compacting" });
  applyRunEvent(auto, { run: 1, kind: "compacted", tokens: null });
  applyRunEvent(auto, { run: 1, kind: "result", text: "Working on it." });
  assert.deepEqual(auto.lines.slice(1), [{ role: "assistant", text: "Working on it." }, { role: "compacted", text: "" }]);

  // A failure takes the waiting line away and says why; one that never ends goes with the turn.
  const failed = chat();
  applyRunEvent(failed, { run: 1, kind: "compacting" });
  applyRunEvent(failed, { run: 1, kind: "compact_failed", text: "Not enough messages to compact." });
  assert.deepEqual(failed.lines, [{ role: "error", text: "Not enough messages to compact." }]);
  const cancelled = chat();
  applyRunEvent(cancelled, { run: 1, kind: "compacting" });
  applyRunEvent(cancelled, { run: 1, kind: "result", text: "" });
  assert.deepEqual(cancelled.lines, []);
  // An automatic one found not needed goes at once, the turn carrying on.
  const skipped = chat();
  applyRunEvent(skipped, { run: 1, kind: "text", text: "Reading." });
  applyRunEvent(skipped, { run: 1, kind: "compacting" });
  applyRunEvent(skipped, { run: 1, kind: "compact_skipped" });
  applyRunEvent(skipped, { run: 1, kind: "tool", tool: "Read", input: { file_path: "C:\\p\\a.ts" } });
  assert.deepEqual(skipped.lines, [{ role: "assistant", text: "Reading." }, { role: "step", text: "Reads · a.ts" }]);

  assert.deepEqual(lineOf({ role: "compacted", text: "", tokens: 964057 }), { role: "compacted", text: "", tokens: 964057 });
  assert.deepEqual(lineOf({ role: "compacted", text: "" }), { role: "compacted", text: "" });
  assert.deepEqual([850, 73870, 999_400, 964_057, 1_234_567].map(tokensShort), ["850", "74k", "999k", "964k", "1.2M"]);
});

test("a session renamed with /rename takes its new name; a side question keeps its own", () => {
  const c = chat();
  applyRunEvent(c, { run: 1, kind: "title", text: "Mic fixes" });
  assert.equal(c.title, "Mic fixes");
  const side = { ...chat(), side: true, title: "s1" };
  applyRunEvent(side, { run: 1, kind: "title", text: "Mic fixes" });
  assert.equal(side.title, "s1");
});

test("only the list code.rs puts after a prompt is read as its files", () => {
  assert.deepEqual(splitAttachments("Attached files:\n- C:\\a.png"), { text: "", files: ["C:\\a.png"] });
  // Typed by hand, or not a list: it is all text.
  for (const text of ["see Attached files: below", "x\nAttached files:\n- C:\\a.png", "x\n\nAttached files:\nnothing", "plain"]) {
    assert.deepEqual(splitAttachments(text), { text, files: [] }, text);
  }
});

test("what is typed while Claude works goes as the next turn, or back if the run fails", () => {
  const c = chat();
  assert.equal(takeQueue(c), null);
  c.queue.push({ text: "also add tests", files: [] }, { text: "", files: ["C:\\inbox\\a.png"] }, { text: "and docs", files: ["C:\\inbox\\b.txt"] });
  const sent = takeQueue(c);
  assert.equal(sent.prompt, "also add tests\n\nand docs");
  assert.deepEqual(sent.attachments, ["C:\\inbox\\a.png", "C:\\inbox\\b.txt"]);
  assert.deepEqual(c.queue, []);
  // Sent: they read as what the user said, in order — the very lines a failed start takes back.
  assert.deepEqual(c.lines, [
    { role: "user", text: "also add tests" },
    { role: "user", text: "", files: ["C:\\inbox\\a.png"] },
    { role: "user", text: "and docs", files: ["C:\\inbox\\b.txt"] },
  ]);
  assert.ok(sent.lines.every((l, i) => l === c.lines[i]));

  c.queue.push({ text: "one", files: [] }, { text: "two", files: ["C:\\inbox\\c.png"] });
  assert.deepEqual(dropQueue(c), { text: "one\n\ntwo", files: ["C:\\inbox\\c.png"] });
  assert.deepEqual(c.queue, []);
  assert.equal(c.lines.length, 3, "taken back, never sent");
  assert.equal(dropQueue(c), null);
});

test("a message code.rs would refuse is refused before anything is cleared", () => {
  const files = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => `C:\\inbox\\${i}.png`);
  assert.equal(tooBig("fine", files), null);
  assert.equal(tooBig("fine", [...files, "C:\\inbox\\one-more.png"]), "At most 20 files at a time.");
  assert.equal(tooBig("x".repeat(MAX_PROMPT), []), null);
  assert.equal(tooBig("x".repeat(MAX_PROMPT + 1), []), "A message is at most 100000 characters.");
  // Counted as code.rs counts: characters (not UTF-16 units), the files' list included.
  assert.equal(sentLength("😀", []), 1);
  assert.equal(sentLength("hi", ["C:\\a.png"]), "hi\n\nAttached files:\n- C:\\a.png".length);
  assert.equal(sentLength("", ["C:\\a.png"]), "Attached files:\n- C:\\a.png".length);
  assert.notEqual(tooBig("x".repeat(MAX_PROMPT - 5), ["C:\\a.png"]), null, "the list counts too");
  // Queued turns go merged: their limits are the merged message's.
  assert.deepEqual(mergeQueued([{ text: "a", files: ["1"] }, { text: "", files: ["2"] }, { text: "b", files: [] }]), { text: "a\n\nb", files: ["1", "2"] });
});

test("a pasted file keeps a real name, a clipboard image gets a dated one", () => {
  const now = new Date(2026, 9, 14, 9, 5, 7);
  assert.equal(pastedName("image.png", "image/png", now), "pasted-20261014-090507.png");
  assert.equal(pastedName("", "image/jpeg", now), "pasted-20261014-090507.jpg");
  assert.equal(pastedName("Quarterly report (final).pdf", "application/pdf", now), "Quarterly report (final).pdf");
  // A header only carries plain ASCII.
  assert.equal(pastedName("Résumé.pdf", "application/pdf", now), "Rsum.pdf");
  assert.equal(pastedName("日本.txt", "text/plain", now), "pasted-20261014-090507.txt");
  assert.equal(pastedName("blob", "application/octet-stream", now), "pasted-20261014-090507.bin");
});

test("times read as minutes or hours, older ones as a date", () => {
  const now = 1_800_000_000_000;
  assert.equal(ago(0, now), "");
  assert.equal(ago(now / 1000 - 20, now), "just now");
  assert.equal(ago(now / 1000 - 5 * 60, now), "5 min ago");
  assert.equal(ago(now / 1000 - 3 * 3600, now), "3 h ago");
  assert.notEqual(ago(now / 1000 - 3 * 86400, now), "");
  assert.equal(folderOf("C:\\Users\\me\\projects\\Music tool\\"), "Music tool");
});
