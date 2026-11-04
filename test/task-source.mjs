// Slack/Gmail 由来のタスクだけに正しいアイコンと遷移先を出す。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../js/task-source.js", import.meta.url), "utf8");
const ctx = { window: {}, URL };
runInNewContext(source, ctx);
const { getOrigin, iconHtml } = ctx.window.GWTaskSource;

const slackUrl = "https://8grp.slack.com/archives/CDVFC71UL/p1793751195968609";
const gmailUrl = "https://mail.google.com/mail/u/0/#all/abc123";

assert.equal(getOrigin({ link: slackUrl, occ_key: "slack:workspace:CDVFC71UL:1793751195.968609" }).kind, "slack");
assert.equal(getOrigin({ link: slackUrl }).href, slackUrl);
assert.equal(getOrigin({ link: gmailUrl, category: "採用" }).kind, "gmail");
assert.equal(getOrigin({ link: gmailUrl }).href, gmailUrl);
assert.equal(getOrigin({ title: "通常タスク", category: "経営" }), null);
assert.equal(getOrigin({ link: "https://not-slack.com/archives/C1/p1234567890" }), null);
assert.equal(getOrigin({ link: "javascript:alert(1)" }), null);
assert.equal(getOrigin({ category: "Slack依頼", occ_key: "slack:workspace:C1:123" }).kind, "slack");
assert.equal(getOrigin({ category: "Gmail依頼" }).kind, "gmail");
assert.equal(getOrigin({ category: "Slack依頼", link: gmailUrl }), null);

const slackMarkup = iconHtml({ link: slackUrl });
assert.match(slackMarkup, /aria-label="Slackの元メッセージを開く"/);
assert.match(slackMarkup, /target="_blank" rel="noopener noreferrer"/);
assert.match(slackMarkup, /onclick="event.stopPropagation\(\)"/);
assert.match(slackMarkup, /#36C5F0/);
assert.match(iconHtml({ link: gmailUrl }), /aria-label="Gmailの元メッセージを開く"/);
assert.match(iconHtml({ link: gmailUrl }), /#EA4335/);
assert.doesNotMatch(iconHtml({ category: "Slack依頼", link: "javascript:alert(1)" }), /href=/);
assert.equal(iconHtml({ title: "メールか不明" }), "");

for (const page of ["home.html", "tasks.html"]) {
  const html = readFileSync(new URL("../" + page, import.meta.url), "utf8");
  assert.match(html, /<script src="js\/task-source\.js\?v=20261104a"><\/script>/);
  assert.match(html, /GWTaskSource\.iconHtml\(t\)/);
}

console.log("task-source icon tests passed");
