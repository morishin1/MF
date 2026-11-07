// KEIEI週次：段階バーは操作可能だが、完了判定は既存データに基づくことを検証。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const flowJs = read("keiei/weekly-workflow.js");
const weekly = read("keiei/weekly.js");
const prep = read("keiei/weekly-prep.js");
const index = read("keiei/index.html");

function harness() {
  const page = { dataset: {} };
  const host = { innerHTML: "", querySelectorAll() { return []; } };
  const root = { querySelector(sel) {
    if (sel === ".kw-page") return page;
    if (sel === "#kw-prep-workflow") return host;
    return null;
  }};
  const styles = new Map();
  const document = {
    getElementById(id) { return styles.get(id) || null; },
    createElement(name) { assert.equal(name, "style"); return { id: "", textContent: "" }; },
    head: { appendChild(st) { styles.set(st.id, st); } },
  };
  const window = {};
  vm.runInNewContext(flowJs, { window, document });
  return { root, page, host, flow: window.KeieiWorkflow, styles };
}

test("経営画面のスクリプトを更新し、4ステップを読み込む", () => {
  assert.match(index, /weekly-workflow\.js\?v=20261108flow1/);
  assert.match(index, /weekly\.js\?v=20261108flow1/);
  assert.match(index, /weekly-prep\.js\?v=20261108flow1/);
  assert.match(weekly, /id="kw-prep-workflow"/);
  assert.match(weekly, /class="kw-workspace"/);
  assert.match(weekly, /<details class="kw-evidence"/);
  assert.equal((weekly.match(/id="kw-prep-feedback"/g) || []).length, 1);
  assert.match(prep, /class="kw-prep-import"/);
  assert.match(prep, /class="kw-prep-review"/);
  for (const name of ["onStatus", "onExport", "onImport", "onSaved", "onWithdraw"]) {
    assert.match(prep, new RegExp("KeieiWorkflow\\?\\." + name + "\\("));
  }
});

test("社員選択後はMD出力から開始し、完了した行程のみ進捗に反映", () => {
  const t = harness();
  t.flow.init(t.root, "emp-1", "2026-11-02", "2026-11-08");
  assert.equal(t.page.dataset.kwStep, "2");
  assert.match(t.host.innerHTML, /aria-valuenow="25"/);
  assert.match(t.host.innerHTML, /出力は未確認/);
  t.flow.onStatus(false, false);
  assert.match(t.host.innerHTML, /未公開/);
  t.flow.onExport();
  assert.equal(t.page.dataset.kwStep, "3");
  assert.match(t.host.innerHTML, /aria-valuenow="50"/);
  t.flow.onImport();
  assert.equal(t.page.dataset.kwStep, "4");
  assert.match(t.host.innerHTML, /aria-valuenow="75"/);
  t.flow.onSaved("save");
  assert.match(t.host.innerHTML, /下書きあり/);
  assert.doesNotMatch(t.host.innerHTML, /本人へ公開済/);
  t.flow.onSaved("publish");
  assert.match(t.host.innerHTML, /aria-valuenow="100"/);
  assert.match(t.host.innerHTML, /本人へ公開済/);
  t.flow.onWithdraw();
  assert.doesNotMatch(t.host.innerHTML, /本人へ公開済/);
});

test("DBに下書きや公開履歴があれば、再読み込みでも確認ステップを案内", () => {
  const t = harness();
  t.flow.init(t.root, "emp-1", "2026-11-02", "2026-11-08");
  t.flow.onStatus(true, false);
  assert.equal(t.page.dataset.kwStep, "4");
  assert.match(t.host.innerHTML, /下書きあり/);
  t.flow.init(t.root, "emp-2", "2026-11-02", "2026-11-08");
  assert.equal(t.page.dataset.kwStep, "2");
  assert.match(t.host.innerHTML, /出力は未確認/);
  t.flow.onStatus(false, true);
  assert.equal(t.page.dataset.kwStep, "4");
  assert.match(t.host.innerHTML, /本人へ公開済/);
});

test("他の操作ステップに移った場合は、遅れて届いたDB状態で画面を上書きしない", () => {
  const t = harness();
  t.flow.init(t.root, "emp-1", "2026-11-02", "2026-11-08");
  t.flow.choose(3);
  t.flow.onStatus(true, false);
  assert.equal(t.page.dataset.kwStep, "3");
  t.flow.init(t.root, "emp-1", "2026-11-09", "2026-11-15");
  assert.equal(t.page.dataset.kwStep, "2");
  assert.match(t.host.innerHTML, /出力は未確認/);
});

test("社員未選択なら他ステップへ進まず、個人情報の公開処理は既存APIを利用する", () => {
  const t = harness();
  t.flow.init(t.root, null, "2026-11-02", "2026-11-08");
  assert.equal(t.page.dataset.kwStep, "1");
  t.flow.choose(4);
  assert.equal(t.page.dataset.kwStep, "1");
  assert.match(t.host.innerHTML, /disabled/);
  assert.match(prep, /\/api\/keiei\/weekly-prep/);
  assert.match(prep, /action, employeeId: currentId/);
  assert.match(prep, /confirm\("この内容を本人のホーム画面へ公開します/);
});
