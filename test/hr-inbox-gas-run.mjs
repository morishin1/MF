// HR採用メールの Apps Script（scripts/google-apps-script/hr-inbox-sync.gs）を、偽の Google の部品で実際に動かす。
//   - DRY RUN では何も送らない
//   - 署名付きで送る中身が、受け口（api/hr/inbox-ingest.js）の検査を通る
//   - 実行記録：自動（トリガー）/手動・成否・件数だけ。件名・アドレス・本文は残さない
//   - トリガーの設置と確認（3本・設置記録・直近の自動実行）
// 架空のメールだけを使う。本物の Gmail・Web には一切つながない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { runInNewContext } from "node:vm";
const src = readFileSync(new URL("../scripts/google-apps-script/hr-inbox-sync.gs", import.meta.url), "utf8");
const SECRET = "x".repeat(40);
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

function world({ dryRun = "1", status = 200, messages = [] } = {}) {
  const props = new Map(Object.entries({
    HR_INBOX_INGEST_URL: "https://gw.8grp.co.jp/api/hr/inbox-ingest", HR_INBOX_SYNC_SECRET: SECRET, HR_INBOX_DRY_RUN: dryRun,
  }));
  const fetched = [], logs = [];
  let triggers = [];
  const msg = (m) => ({
    getTo: () => m.to, getCc: () => "", getHeader: () => "", getId: () => m.id, getDate: () => new Date(m.date),
    getSubject: () => m.subject, getFrom: () => m.from, getReplyTo: () => m.replyTo || "", getPlainBody: () => m.body,
  });
  const builder = () => {
    const t = { handler: null, hour: null, tz: null };
    const b = {
      timeBased: () => b, atHour: (h) => { t.hour = h; return b; }, nearMinute: () => b, everyDays: () => b,
      inTimezone: (z) => { t.tz = z; return b; },
      create: () => { const tr = { getHandlerFunction: () => t.handler, hour: t.hour, tz: t.tz }; triggers.push(tr); return tr; },
    };
    return (h) => { t.handler = h; return b; };
  };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)) }) },
    GmailApp: { search: () => [{ getMessages: () => messages.map(msg) }] },
    Utilities: {
      Charset: { UTF_8: "utf8" },
      computeHmacSha256Signature: (value, key) => [...createHmac("sha256", key).update(value, "utf8").digest()].map((b) => (b > 127 ? b - 256 : b)),
    },
    UrlFetchApp: { fetch: (url, opt) => { fetched.push({ url, opt }); const body = JSON.parse(opt.payload);
      return { getResponseCode: () => status, getContentText: () => JSON.stringify({ ok: true, inserted: body.messages.length, duplicates: 0 }) }; } },
    ScriptApp: {
      getProjectTriggers: () => triggers, deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
      newTrigger: (h) => builder()(h),
    },
    Logger: { log: (s) => logs.push(String(s)) },
    Date, JSON, Math, Number, String, Array, Object,
  };
  runInNewContext(src, ctx);
  return { ctx, props, fetched, logs, triggers: () => triggers };
}
const now = Date.now();
const mails = [
  { id: "aaaaaaaaaaaa01", to: "saiyou@8grp.co.jp", date: now - 3600e3, subject: "【架空】応募 山田", from: "Wantedly <no-reply@wantedly.com>", body: "氏名：架空 山田" },
  { id: "aaaaaaaaaaaa02", to: "other@example.com", date: now - 3600e3, subject: "対象外", from: "x@example.com", body: "x" },
];

// ---- DRY RUN：送らない。記録は手動・DRY RUN・候補数だけ ----
let w = world({ dryRun: "1", messages: mails });
let r = w.ctx.syncRecruitmentInbox();
ok(r.dryRun === true && r.candidates === 1 && w.fetched.length === 0, "DRY RUN は送らない（宛先外は候補にしない）");
let log = JSON.parse(w.props.get("HR_INBOX_RUN_LOG"));
ok(log.length === 1 && log[0].by === "manual" && log[0].dryRun === true && log[0].candidates === 1 && log[0].ok === true, "手動・DRY RUN を記録");

// ---- 本実行（トリガーから）：署名付きで送り、受け口の形にそろう ----
w = world({ dryRun: "0", messages: mails });
r = w.ctx.syncRecruitmentInbox({ triggerUid: "t-1" });
ok(r.inserted === 1 && w.fetched.length === 1, "1通だけ送る");
const sent = w.fetched[0];
ok(sent.url === "https://gw.8grp.co.jp/api/hr/inbox-ingest" && sent.opt.followRedirects === false, "送り先は固定・リダイレクトしない");
const stamp = sent.opt.headers["X-Eight-Timestamp"];
const expectSig = createHmac("sha256", SECRET).update(stamp + "." + sent.opt.payload, "utf8").digest("hex");
ok(sent.opt.headers["X-Eight-Signature"] === expectSig, "署名＝HMAC(timestamp.body)");
const body = JSON.parse(sent.opt.payload);
ok(body.messages[0].recipient === "saiyou@8grp.co.jp" && body.messages[0].sender === "no-reply@wantedly.com", "宛先・差出人を受け口の形で送る");
log = JSON.parse(w.props.get("HR_INBOX_RUN_LOG"));
ok(log[0].by === "trigger" && log[0].inserted === 1 && log[0].ok === true, "自動実行として記録");
ok(!/山田|wantedly|saiyou|架空/.test(w.props.get("HR_INBOX_RUN_LOG")), "記録に件名・アドレス・本文を残さない");
ok(!w.logs.some((l) => /山田|wantedly\.com|架空/.test(l)), "ログに個人情報を出さない");

// ---- 失敗：記録は失敗とHTTPコードだけ。例外は投げ直す（Apps Script の失敗通知に乗る） ----
w = world({ dryRun: "0", status: 503, messages: mails });
assert.throws(() => w.ctx.syncRecruitmentInbox({ triggerUid: "t-2" }));
log = JSON.parse(w.props.get("HR_INBOX_RUN_LOG"));
ok(log[0].ok === false && log[0].error === "http_503" && log[0].by === "trigger", "失敗を記録（HTTPコードだけ）");

// ---- 記録は直近20回まで ----
w = world({ dryRun: "1", messages: [] });
for (let i = 0; i < 25; i++) w.ctx.syncRecruitmentInbox();
ok(JSON.parse(w.props.get("HR_INBOX_RUN_LOG")).length === 20, "記録は20回まで");

// ---- トリガー：設置→確認 ----
w = world({ dryRun: "1", messages: [] });
let rep = w.ctx.checkRecruitmentMailTriggers();
ok(rep.triggerCount === 0 && rep.ok === false && rep.installed === null && rep.lastTriggerRun === null, "設置前は0本・記録なし");
w.ctx.installRecruitmentMailTriggers();
w.ctx.installRecruitmentMailTriggers();   // 2回押しても増えない
ok(w.triggers().length === 3 && w.triggers().map((t) => t.hour).join() === "9,13,17" && w.triggers().every((t) => t.tz === "Asia/Tokyo"), "9/13/17時 JST の3本（2回設置しても3本）");
w.ctx.syncRecruitmentInbox({ triggerUid: "t-3" });
rep = w.ctx.checkRecruitmentMailTriggers();
ok(rep.ok === true && rep.installed.hours.join() === "9,13,17" && rep.lastTriggerRun && rep.lastTriggerRun.by === "trigger", "確認：3本・設置記録・直近の自動実行");
ok(w.logs.some((l) => l.includes("3本（期待3本）")), "確認結果をログに出す");
w.ctx.removeRecruitmentMailTriggers();
ok(w.ctx.checkRecruitmentMailTriggers().triggerCount === 0, "停止で0本");
console.log(`HR採用メール Apps Script（実行）：DRY RUN・署名・実行記録・トリガー確認 ${n}ケース PASS`);
