// Synthetic data only; exercise the actual copy controller without a browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const script = readFileSync(new URL("../js/calendar-duplicate.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../calendar.html", import.meta.url), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
let count = 0;
function test(name, fn) { fn(); count++; console.log("ok " + name); }
const source = Object.freeze({ id: "original", title: "定例の準備", body: "本人用メモ <>&", location: "会議室A",
  category: "meeting", all_day: false, source: "self", visibility: "shared", starts_at: "2026-10-28T14:30:00Z", ends_at: "2026-10-29T01:00:00Z",
  tenant_id: "source-tenant", employee_id: "source-member", status: "done", created_at: "2026-01-01", updated_at: "2026-02-02",
  gcal_event_id: "external", gcal_synced_at: "yesterday", source_id: "link", attendees: ["someone"], history: ["old"] });

function harness(create = async () => {}, onSaved = async () => {}, onUncertain = () => {}) {
  const listeners = {}, fields = {};
  const doc = { body: { style: { overflow: "scroll" } }, activeElement: null,
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); } };
  function node(extra = {}) {
    return { value: "", checked: false, disabled: false, textContent: "", isConnected: true, listeners: {},
      addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
      async fire(name, event = {}) { for (const fn of this.listeners[name] || []) await fn({ target: this, preventDefault() {}, ...event }); },
      focus() { doc.activeElement = this; }, ...extra };
  }
  for (const name of ["title", "body", "location", "category", "startDate", "endDate", "startTime", "endTime", "allDay", "quantity"]) fields[name] = node();
  const closeTop = node(), closeBottom = node(), submit = node(), status = node(), quantityNote = node();
  const form = node({ reset() { for (const field of Object.values(fields)) { field.value = ""; field.checked = false; } } });
  const controls = [closeTop, ...Object.values(fields), closeBottom, submit];
  const root = node({ hidden: true,
    querySelector(selector) {
      if (selector === "form") return form;
      if (selector === '[role="status"]') return status;
      if (selector === "#copy-quantity-note") return quantityNote;
      if (selector === '[type="submit"]') return submit;
      return fields[selector.match(/^\[name="(.*)"\]$/)?.[1]];
    },
    querySelectorAll(selector) { return selector === "[data-duplicate-close]" ? [closeTop, closeBottom] : controls; },
    contains(value) { return controls.includes(value); } });
  const opener = node(); opener.focus();
  const window = { addEventListener: doc.addEventListener };
  runInNewContext(readFileSync(new URL("../js/calendar-quantity.js", import.meta.url), "utf8"), { window });
  runInNewContext(script, { window, document: doc, Date, Error });
  const api = window.CalendarDuplicate;
  const controller = api.init({ root, create, onSaved, onUncertain });
  const key = (key, shiftKey = false) => { const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; } }; for (const fn of listeners.keydown || []) fn(event); return event; };
  const navigate = name => { for (const fn of listeners[name] || []) fn({}); };
  return { ...api, ...controller, navigate, quantityNote, root, form, fields, status, submit, closeTop, closeBottom, controls, doc, opener, key };
}
const h = harness();
const values = clone(h.draft(source));
test("JST日付と日またぎ・内容だけを引き継ぐ", () => {
  assert.deepEqual(values, { title: source.title, body: source.body, location: source.location, category: "meeting", allDay: false,
    startDate: "2026-10-28", endDate: "2026-10-29", startTime: "23:30", endTime: "10:00", quantity: "" });
});
test("本人の手入力業務以外を複製しない", () => {
  for (const bad of [null, { ...source, source: "leave" }, { ...source, source: "booking" }, { ...source, source: "google" },
    { ...source, category: "private" }, { ...source, visibility: "private" }, { ...source, visibility: "busy" }, { ...source, visibility: undefined }, { ...source, own: false }, { ...source, source: "hr" }, { ...source, category: "unknown" }, { ...source, starts_at: "invalid" }]) assert.equal(h.draft(bad), null);
  assert.ok(h.draft({ ...source, employee_id: undefined }), "本物のGETにはemployee_idが含まれない");
});
test("保存は明示allowlistのみ、所有者・ID・履歴・同期・参加者の再利用なし", () => {
  const result = clone(h.payload({ ...values, ...source }));
  assert.deepEqual(Object.keys(result).sort(), ["title", "body", "location", "category", "allDay", "startsAt", "endsAt", "visibility"].sort());
  assert.equal(result.visibility, "shared");
  assert.equal(result.startsAt, "2026-10-28T23:30:00+09:00");
  assert.equal(result.endsAt, "2026-10-29T10:00:00+09:00");
});
test("終日単日・複数日の終了日は包含で23:59", () => {
  const result = h.payload({ ...values, allDay: true, startTime: "", endTime: "" });
  assert.equal(result.startsAt, "2026-10-28T00:00:00+09:00");
  assert.equal(result.endsAt, "2026-10-29T23:59:00+09:00");
  assert.equal(h.payload({ ...values, allDay: true, endDate: values.startDate }).endsAt, "2026-10-28T23:59:00+09:00");
});
test("無効日付・日時逆転・同時刻・1年超を送らない", () => {
  for (const patch of [{ title: " " }, { startDate: "2026-02-30" }, { endDate: "" }, { startTime: "24:00" },
    { endDate: values.startDate }, { endDate: values.startDate, endTime: values.startTime }, { endDate: "2028-10-29" }, { category: "private" }]) {
    assert.throws(() => h.payload({ ...values, ...patch }));
  }
  assert.doesNotThrow(() => h.payload({ ...values, startDate: "2028-02-29", endDate: "2028-03-01" }));
});
test("元オブジェクト不変・初回表示は日付にフォーカス", () => {
  const before = clone(source); assert.equal(h.open(source), true);
  assert.equal(h.root.hidden, false); assert.equal(h.doc.activeElement, h.fields.startDate);
  assert.equal(h.doc.body.style.overflow, "hidden"); assert.deepEqual(source, before);
});
await h.fields.startDate.fire("change", (h.fields.startDate.value = "2026-12-31", {}));
test("開始日変更で年をまたぐ終了日も同じ日数ずれる", () => { assert.equal(h.fields.endDate.value, "2027-01-01"); });
h.fields.title.value = "変更途中";
test("複製を連打しても入力中の草案を初期化しない", () => { assert.equal(h.open(source), false); assert.equal(h.fields.title.value, "変更途中"); });
h.fields.allDay.checked = true; await h.fields.allDay.fire("change");
test("終日変更で時間入力だけを無効にする", () => { assert.equal(h.fields.startTime.disabled, true); assert.equal(h.fields.endTime.disabled, true); });
h.fields.allDay.checked = false; await h.fields.allDay.fire("change");
test("終日を解除すると元の時刻が残る", () => { assert.equal(h.fields.startTime.disabled, false); assert.equal(h.fields.startTime.value, "23:30"); });
h.submit.focus();
test("Tab/Shift+Tabはモーダル内を循環", () => { assert.equal(h.key("Tab").prevented, true); assert.equal(h.doc.activeElement, h.closeTop); assert.equal(h.key("Tab", true).prevented, true); assert.equal(h.doc.activeElement, h.submit); });
h.key("Escape");
test("Escで破棄・スクロールとフォーカス復元", () => { assert.equal(h.root.hidden, true); assert.equal(h.doc.body.style.overflow, "scroll"); assert.equal(h.doc.activeElement, h.opener); });
h.open(source); await h.closeBottom.fire("click");
test("キャンセルで未保存草案破棄、再度複製は原本から", () => { h.open(source); assert.equal(h.fields.title.value, source.title); assert.equal(h.fields.startDate.value, values.startDate); });
await h.root.fire("click");
test("背景クリックでも保存なしで閉じる", () => { assert.equal(h.root.hidden, true); });

let posted = [], saved = [], finish;
const saveHarness = harness(body => { posted.push(clone(body)); return new Promise(resolve => { finish = resolve; }); }, async body => { saved.push(clone(body)); });
saveHarness.open(source); saveHarness.fields.title.value = "複製後の内容";
saveHarness.fields.startDate.value = "2026-11-03"; await saveHarness.fields.startDate.fire("change");
const pending = saveHarness.form.fire("submit");
await saveHarness.form.fire("submit");
saveHarness.close(); saveHarness.key("Escape");
test("保存連打はPOST1回・保存中Close/Esc/別複製を拒否", () => {
  assert.equal(posted.length, 1); assert.ok(saveHarness.controls.every(n => n.disabled));
  assert.equal(saveHarness.root.hidden, false); assert.equal(saveHarness.open(source), false);
});
finish(); await pending; await saveHarness.form.fire("submit");
test("編集した内容を新規保存後に閉じる・再送なし・元予定不変", () => {
  assert.equal(posted.length, 1); assert.equal(saved.length, 1); assert.equal(posted[0].title, "複製後の内容");
  assert.equal(posted[0].startsAt, "2026-11-03T23:30:00+09:00"); assert.equal(posted[0].endsAt, "2026-11-04T10:00:00+09:00");
  assert.equal(saveHarness.root.hidden, true); assert.equal(source.title, "定例の準備");
});
let failedPosts = 0;
const failed = harness(async () => { failedPosts++; throw Error("lost response"); });
failed.open(source); failed.fields.startDate.value = "2026-11-03"; await failed.fields.startDate.fire("change"); await failed.form.fire("submit"); await failed.form.fire("submit");
test("保存結果不明は自動再送せず確認を案内・閉じるのみ許可", () => {
  assert.equal(failedPosts, 1); assert.match(failed.status.textContent, /ページを再読み込みし、登録済みか確認/);
  assert.equal(failed.submit.disabled, true); assert.equal(failed.closeBottom.disabled, false);
  failed.close(); assert.equal(failed.root.hidden, true); assert.equal(failed.open(source), false);
});
let rejectedPosts = 0;
const rejected = harness(async () => { rejectedPosts++; throw Object.assign(Error("invalid"), { status: 400, hint: "入力値を確認" }); });
rejected.open(source); rejected.fields.startDate.value = "2026-11-03"; await rejected.fields.startDate.fire("change"); await rejected.form.fire("submit");
test("確定的な入力拒否は保存なしと明示し、草案を保持して修正可能", () => {
  assert.match(rejected.status.textContent, /保存されていません/); assert.equal(rejected.fields.title.value, source.title);
  assert.equal(rejected.submit.disabled, false); assert.equal(rejected.fields.title.disabled, false);
});
let refreshPosts = 0;
const refreshFail = harness(async () => { refreshPosts++; }, async () => { throw Error("refresh failed"); });
refreshFail.open(source); refreshFail.fields.startDate.value = "2026-11-03"; await refreshFail.fields.startDate.fire("change"); await refreshFail.form.fire("submit"); await refreshFail.form.fire("submit");
test("保存後再読み込み失敗は作成失敗扱い/再送にしない", () => { assert.equal(refreshPosts, 1); assert.equal(refreshFail.root.hidden, true); });
const validation = harness(async () => assert.fail("invalid draft must not be sent"));
validation.open(source); validation.fields.title.value = ""; await validation.form.fire("submit");
test("入力検証エラー後は入力を修正できる", () => { assert.match(validation.status.textContent, /業務内容/); assert.equal(validation.fields.title.disabled, false); assert.equal(validation.submit.disabled, false); });
test("画面導線は自分モードのみ、複製は既存のcreateEventを使用", () => {
  assert.match(html, /function duplicateEvent\(id\)\{\s*if\(scope!=="mine"\|\|busy\|\|batchSaving/);
  assert.match(html, /const source=events\.find/); assert.match(html, /CalendarDuplicate\.draft\(source\)/);
  assert.match(html, /create:fields=>API\.createEvent\(fields\)/);
  assert.match(html, /e\.own&&scope==="mine"\?[^\n]*duplicateEvent/);
});
let untouchedPosts = 0;
const untouched = harness(async () => { untouchedPosts++; });
untouched.open(source); await untouched.form.fire("submit");
test("元の日付・時刻のままでは登録せず新日時を要求", () => { assert.equal(untouchedPosts, 0); assert.match(untouched.status.textContent, /新しい開始日または時刻/); });
untouched.fields.startTime.value = "22:30"; await untouched.fields.startTime.fire("change");
test("開始時刻変更でも時間幅と日またぎを保持", () => { assert.equal(untouched.fields.endDate.value, "2026-10-29"); assert.equal(untouched.fields.endTime.value, "09:00"); });
untouched.navigate("popstate");
test("Back/Forwardは未保存フォームを破棄し書込みなし", () => { assert.equal(untouched.root.hidden, true); assert.equal(untouchedPosts, 0); });
untouched.open(source); untouched.navigate("pagehide");
test("離脱時も下書きを破棄して復元時の残留を防ぐ", () => { assert.equal(untouched.root.hidden, true); });
const quantitySource = { ...source, planned_quantity: 0, planned_quantity_unit: "件" };
let quantityPosts = [];
const quantity = harness(async body => { quantityPosts.push(clone(body)); });
quantity.open(quantitySource, { quantityAvailable: true });
test("数量ゼロを空欄にせず引き継ぐ", () => { assert.equal(quantity.fields.quantity.value, "0件"); assert.equal(quantity.fields.quantity.disabled, false); });
quantity.fields.startDate.value = "2026-11-03"; await quantity.fields.startDate.fire("change");
quantity.fields.quantity.value = "-1件"; await quantity.form.fire("submit");
test("無効な数字は送信せず下書きを保持", () => { assert.equal(quantityPosts.length, 0); assert.equal(quantity.fields.quantity.value, "-1件"); });
quantity.fields.quantity.value = "0件"; await quantity.form.fire("submit");
test("数量は実績でなく予定値のみ許可リストで送信", () => { assert.equal(quantityPosts[0].plannedQuantity, 0); assert.equal(quantityPosts[0].plannedQuantityUnit, "件"); });
const oldSchema = harness(async body => { quantityPosts.push(clone(body)); });
oldSchema.open(source, { quantityAvailable: false }); oldSchema.fields.startDate.value = "2026-11-03"; await oldSchema.fields.startDate.fire("change");
test("旧schemaは数字を無効にして時間・内容を利用可能", () => { assert.equal(oldSchema.fields.quantity.disabled, true); assert.match(oldSchema.quantityNote.textContent, /時間・内容だけ/); });
await oldSchema.form.fire("submit");
test("旧schemaへ数量キーを送らない", () => { assert.equal(Object.hasOwn(quantityPosts[1], "plannedQuantity"), false); });
const staleQuantity = harness(async () => assert.fail("must not drop original number"));
staleQuantity.open(quantitySource, { quantityAvailable: false }); staleQuantity.fields.startDate.value = "2026-11-03"; await staleQuantity.fields.startDate.fire("change"); await staleQuantity.form.fire("submit");
test("数字が読めたのに保存能力不明なら黙って削除せず停止", () => { assert.match(staleQuantity.status.textContent, /元の数字を保存できるか確認できません/); });
const schemaRace = harness(async () => { throw Object.assign(Error("schema"), {status:503, code:"calendar_quantity_unavailable", hint:"数字の保存は未準備"}); });
schemaRace.open(quantitySource, { quantityAvailable: true }); schemaRace.fields.startDate.value = "2026-11-03"; await schemaRace.fields.startDate.fire("change"); await schemaRace.form.fire("submit");
test("既知の数量schema拒否は入力を保持し自動再送しない", () => { assert.equal(schemaRace.fields.quantity.value, "0件"); assert.equal(schemaRace.submit.disabled, false); assert.match(schemaRace.status.textContent, /保存されていません/); });
let uncertainCalls = 0;
const knownUnknown = harness(async () => { throw Error("network"); }, async () => {}, () => { uncertainCalls++; });
knownUnknown.open(source); knownUnknown.fields.startDate.value = "2026-11-03"; await knownUnknown.fields.startDate.fire("change"); await knownUnknown.form.fire("submit"); knownUnknown.close();
test("結果不明をページ全体へ伝え閉じて再表示も拒否", () => { assert.equal(uncertainCalls, 1); assert.equal(knownUnknown.open(source), false); });
console.log(`${count} calendar duplicate checks passed`);
// Exercise the actual page entry point without a browser, not just a text match.
function entryHarness() {
  const entries = [source, {...source,id:"private",visibility:"private"}, {...source,id:"other",employee_id:"other-member"},
    ...["booking","leave","hr","google"].map(value=>({...source,id:value,source:value}))];
  const calls = [], context = { scope:"mine",busy:false,batchSaving:false,calendarWriteUncertain:false,quantityAvailable:true,
    events:entries,myEmployeeId:"source-member", CalendarDuplicate:{draft:h.draft,init:()=>({isOpen:()=>false,open:(value,options)=>calls.push([value,options])})},
    el:()=>({}), API:{},closeForm(){},closeBatch(){},closeDayDrawer(){},message(){},load:async()=>{} };
  runInNewContext(html.slice(html.indexOf("  const duplicateDialog="),html.indexOf("  function newEvent()")),context);
  return {context,calls};
}
const entry = entryHarness(); entry.context.duplicateEvent(source.id);
test("実画面ハンドラは本人の読込済み原本のみを数量能力と共に渡す", () => { assert.equal(entry.calls.length,1); assert.equal(entry.calls[0][0],source); assert.equal(entry.calls[0][1].quantityAvailable,true); });
for (const id of ["missing","private","other","booking","leave","hr","google"]) entry.context.duplicateEvent(id);
test("実画面ハンドラは不在・他人・非公開・自動生成を拒否", () => { assert.equal(entry.calls.length,1); });
entry.context.scope="team"; entry.context.duplicateEvent(source.id); entry.context.scope="mine";entry.context.calendarWriteUncertain=true;entry.context.duplicateEvent(source.id);
test("全員モードと結果不明の再複製も実画面ハンドラで拒否", () => { assert.equal(entry.calls.length,1); });
console.log(`${count} total calendar duplicate checks passed`);
