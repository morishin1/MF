// メンバー管理の一括登録・一覧の判定（js/member-bulk.js）を、画面を開かずに確かめる。
//
// ■ 守るもの
//   ・CSV と表計算の貼り付け（タブ区切り）を正しく読む：引用符・欄の中の改行・"" ・BOM・CRLF・空行・見出し
//   ・閉じていない引用符など、読めない形は「読めない」と返す（列をずらして黙って登録しない）
//   ・登録前のプレビュー：必須・形式・ファイル内の重複・登録済みを、行ごとに分ける。登録済みは上書きしない
//   ・送る行は「登録できる行」だけ。結果は元の行番号で返す
//   ・一覧の検索・絞り込み・ページ分け（退職者は既定で隠す）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// 画面と同じファイルを、そのまま読む（window.MemberBulk）。同じ realm で動かす（配列の比較を素直にするため）
const window = {};
new Function("window", "globalThis", readFileSync(join(ROOT, "js/member-bulk.js"), "utf8"))(window, window);
const M = window.MemberBulk;

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("NG:", name, "\n   ", e.message); }
};
const cells = (r) => r.rows.map((x) => x.cells);

console.log("— 読み取り（CSV・タブ区切り）—");
ok("タブ区切り（表計算からの貼り付け）。カンマは区切りにしない", () => {
  const r = M.parseDelimited("山田 太郎\ttaro@example.com\t管理部, 総務\n鈴木 花子\thanako@example.com\t営業部");
  assert.equal(r.delimiter, "\t");
  assert.deepEqual(cells(r), [["山田 太郎", "taro@example.com", "管理部, 総務"], ["鈴木 花子", "hanako@example.com", "営業部"]]);
});
ok("CSV：引用符の中のカンマ・改行・\"\"", () => {
  const r = M.parseDelimited('"山田, 太郎",taro@example.com,"管理部\n総務課","主任 ""A"""\r\n鈴木,hanako@example.com');
  assert.equal(r.delimiter, ",");
  assert.equal(r.error, null);
  assert.deepEqual(cells(r), [["山田, 太郎", "taro@example.com", "管理部\n総務課", '主任 "A"'], ["鈴木", "hanako@example.com"]]);
  assert.deepEqual(r.rows.map((x) => x.line), [1, 3], "行番号は、その行が始まる元の行（欄の中の改行を数える）");
});
ok("BOM・CRLF・CR・空行・区切りだけの行", () => {
  const r = M.parseDelimited("﻿氏名,メール\r\n\r\n山田,a@example.com\r,,,\r\n鈴木,b@example.com\n");
  assert.deepEqual(cells(r), [["氏名", "メール"], ["山田", "a@example.com"], ["鈴木", "b@example.com"]]);
  assert.equal(r.rows[0].cells[0], "氏名", "BOM が氏名の頭に付かない");
});
ok("タブ区切りでも、引用符の中のタブ・改行（Excel の複数行セル）", () => {
  const r = M.parseDelimited('山田\t"管理部\n総務"\t"a\tb"\n鈴木\t営業');
  assert.deepEqual(cells(r), [["山田", "管理部\n総務", "a\tb"], ["鈴木", "営業"]]);
});
ok("閉じていない引用符は読めない（行番号つき）", () => {
  const r = M.parseDelimited('山田,a@example.com\n"鈴木,b@example.com\n佐藤,c@example.com');
  assert.equal(r.error.code, "unclosed_quote");
  assert.equal(r.error.line, 2);
});
ok("閉じた引用符のあとに文字が続く（\"abc\"x）は読めない", () => {
  const r = M.parseDelimited('"山田"太郎,a@example.com');
  assert.equal(r.error.code, "bad_quote");
});
ok("最後の欄が空の行・末尾の改行なし", () => {
  const r = M.parseDelimited("山田,a@example.com,");
  assert.deepEqual(cells(r), [["山田", "a@example.com", ""]]);
});

console.log("\n— 見出し・列 —");
ok("見出しがあれば、見出しで列を読む（順番が違ってもよい）", () => {
  const { records, header, unknownColumns } = M.toRecords(M.parseDelimited("メールアドレス,氏名,入社日,備考\na@example.com,山田,2026/4/1,x").rows);
  assert.equal(header, true);
  assert.deepEqual(unknownColumns, ["備考"]);
  assert.equal(records[0].value.display_name, "山田");
  assert.equal(records[0].value.email, "a@example.com");
  assert.equal(records[0].value.joined_on, "2026/4/1");
  assert.equal(records[0].line, 2);
});
ok("見出しが無ければ、氏名 / メール / 部署 / 役職 / 雇用区分 / 入社日 の順", () => {
  const { records, header } = M.toRecords(M.parseDelimited("山田\ta@example.com\t管理部\t主任\t正社員\t2026-04-01").rows);
  assert.equal(header, false);
  assert.deepEqual(records[0].value, { display_name: "山田", email: "a@example.com", department: "管理部", position: "主任", employment_type: "正社員", joined_on: "2026-04-01" });
});
ok("データの1行目を見出しと取り違えない（氏名の列が見出しで無ければ、見出しではない）", () => {
  const { header } = M.toRecords(M.parseDelimited("部署,役職\n山田,主任").rows);
  assert.equal(header, false);
});

console.log("\n— プレビュー（登録はしない）—");
const EXISTING = [{ display_name: "既存 一郎", email: "ichiro@example.com" }, { display_name: "既存 二郎", email: null }];
const pv = (text) => M.previewText(text, EXISTING);
ok("登録できる・入力エラー・登録済み・ファイル内の重複を、行ごとに分ける", () => {
  const p = pv([
    "氏名,メール,部署,役職,雇用区分,入社日",
    "新規 太郎,taro@example.com,管理部,,正社員,2026/4/1",
    ",nobody@example.com",                         // 氏名が空
    "形式 花子,not-an-email",                     // メールの形
    "区分 三郎,saburo@example.com,,,派遣",          // 雇用区分
    "日付 四郎,shiro@example.com,,,,2026-02-30",   // 実在しない日付
    "既存 一郎,new@example.com",                   // 登録済み（氏名）
    "別名,ICHIRO@example.com",                     // 登録済み（メール。大文字小文字は同じ）
    "新規 太郎,other@example.com",                 // ファイル内の重複（氏名）
    "別人,TARO@example.com",                       // ファイル内の重複（メール）
  ].join("\n"));
  assert.equal(p.error, null);
  const st = p.items.map((x) => [x.line, x.status]);
  assert.deepEqual(st, [[2, "ok"], [3, "error"], [4, "error"], [5, "error"], [6, "error"], [7, "registered"], [8, "registered"], [9, "duplicate"], [10, "duplicate"]]);
  assert.deepEqual(p.summary, { total: 9, ok: 1, error: 4, registered: 2, duplicate: 2 });
  assert.equal(p.items[0].value.joined_on, "2026-04-01", "入社日は 2026-04-01 の形にそろえる");
  assert.equal(p.items[0].value.email, "taro@example.com");
  assert.match(p.items[1].reasons.join(), /氏名が空/);
  assert.match(p.items[2].reasons.join(), /メールアドレスの形/);
  assert.match(p.items[3].reasons.join(), /雇用区分「派遣」/);
  assert.match(p.items[4].reasons.join(), /入社日「2026-02-30」/);
  assert.match(p.items[5].reasons.join(), /名簿にいます/);
  assert.match(p.items[6].reasons.join(), /既存 一郎/);
  assert.match(p.items[7].reasons.join(), /2行目と同じ氏名/);
  assert.match(p.items[8].reasons.join(), /2行目と同じメール/);
});
ok("入力エラーの行は、重複の数え始めにしない（直した後に、ファイル内の重複として誤って止めない）", () => {
  const p = pv("山田,bad\n山田,ok@example.com");
  assert.deepEqual(p.items.map((x) => x.status), ["error", "ok"]);
});
ok("列が多すぎる行は、ずれた可能性があるので止める", () => {
  const p = pv("山田\ta@example.com\t管理部\t主任\t正社員\t2026-04-01\t余分");
  assert.equal(p.items[0].status, "error");
  assert.match(p.items[0].reasons.join(), /列が多すぎます/);
});
ok("欄の中の改行は止める（氏名に改行が入ったまま名簿に入れない）", () => {
  const p = pv('"山田\n太郎",a@example.com');
  assert.equal(p.items[0].status, "error");
});
ok("200行を超えると、送れない（tooMany）", () => {
  const lines = Array.from({ length: 201 }, (_, i) => `人${i},p${i}@example.com`);
  assert.equal(pv(lines.join("\n")).tooMany, true);
  assert.equal(pv(lines.slice(0, 200).join("\n")).tooMany, false);
});
ok("読めない形はプレビューを出さない", () => {
  const p = pv('"山田,a@example.com');
  assert.match(p.error, /閉じられていません/);
  assert.equal(p.items.length, 0);
});
ok("空なら「読み取れる行がありません」", () => {
  assert.match(pv("\n\n").error, /読み取れる行/);
  assert.match(pv("氏名,メール\n").error, /読み取れる行/);
});

console.log("\n— 送る行と結果の仕分け —");
ok("送るのは登録できる行だけ。結果は元の行番号で返す", () => {
  const p = pv("氏名,メール\nA,a@example.com\n,x@example.com\nB,b@example.com\nC,\nD,d@example.com");
  const sent = M.rowsToSend(p.items);
  assert.deepEqual(sent.rows.map((r) => r.display_name), ["A", "B", "C", "D"]);
  assert.deepEqual(sent.lines, [2, 4, 5, 6]);
  const res = {
    added: [
      { line: 1, name: "A", id: "e1", account: "created", password: "pw" },
      { line: 3, name: "C", id: "e3", account: "no_email" },
      { line: 4, name: "D", id: "e4", account: "failed", accountError: "x" },
    ],
    skipped: [{ line: 2, name: "B", reason: "同じ氏名の人が既にいます" }],
    failed: [],
    withAccounts: true,
  };
  const c = M.classifyResult(res, sent);
  assert.deepEqual(c.added.map((a) => a.srcLine), [2, 5, 6]);
  assert.deepEqual(c.skipped.map((a) => a.srcLine), [4]);
  assert.equal(c.accountCreated.length, 1);
  assert.equal(c.accountFailed[0].name, "D");
  assert.equal(c.accountNoEmail[0].name, "C");
  assert.equal(c.accountFailed[0].value.email, "d@example.com", "アカウントの再試行に使うメールを持っている");
});
ok("失敗した行だけを、見出しつきのタブ区切りに戻す（引用符が要る欄は囲む）", () => {
  const t = M.toTsv([{ display_name: "山田", email: "a@example.com", department: 'x"y', position: "", employment_type: "", joined_on: "" }]);
  assert.equal(t, '氏名\tメール\t部署\t役職\t雇用区分\t入社日\n山田\ta@example.com\t"x""y"\t\t\t');
  const back = M.previewText(t, []);
  assert.equal(back.items[0].value.department, 'x"y', "戻した文字をもう一度読める");
});

console.log("\n— 一覧：検索・絞り込み・ページ —");
const L = [
  { id: "1", display_name: "山田 太郎", email: "taro@example.com", department: "管理部", employment_type: "正社員", status: "active", apps: { hr: true, sales: false, office: true, keiei: false } },
  { id: "2", display_name: "鈴木 花子", email: "hanako@example.com", department: "営業部", employment_type: "契約社員", status: "invited", apps: { hr: false, sales: true, office: false, keiei: false } },
  { id: "3", display_name: "佐藤 退職", email: "left@example.com", department: "営業部", employment_type: "正社員", status: "left", apps: { hr: false, sales: false, office: false, keiei: false } },
  { id: "4", display_name: "田中 なし", email: "none@example.com", department: "開発", employment_type: "業務委託", status: "active", apps: { hr: false, sales: false, office: false, keiei: false } },
];
const ids = (f) => M.filterMembers(L, f).map((e) => e.id).join(",");
ok("退職者は既定で出さない。切り替えると出る。基本区分で「退職」を選んだら出る", () => {
  assert.equal(ids({}), "1,2,4");
  assert.equal(ids({ showLeft: true }), "1,2,3,4");
  assert.equal(ids({ status: "left" }), "3");
});
ok("検索（氏名・メール・部署。空白と大文字小文字を無視）", () => {
  assert.equal(ids({ q: "山田太郎" }), "1");
  assert.equal(ids({ q: "HANAKO" }), "2");
  assert.equal(ids({ q: "営業部", showLeft: true }), "2,3");
});
ok("雇用区分・使える業務（なし＝4つとも使えない）", () => {
  assert.equal(ids({ type: "正社員" }), "1");
  assert.equal(ids({ app: "office" }), "1");
  assert.equal(ids({ app: "none" }), "4");
});
ok("選択中だけ表示", () => {
  assert.equal(ids({ onlyIds: new Set(["2", "3"]), showLeft: true }), "2,3");
});
ok("ページ分け（範囲外のページは端に寄せる）", () => {
  const list = Array.from({ length: 61 }, (_, i) => i);
  assert.deepEqual(M.pageOf(list, 2, 30).rows, list.slice(30, 60));
  const last = M.pageOf(list, 9, 30);
  assert.equal(last.page, 3);
  assert.deepEqual([last.from, last.to, last.pages], [61, 61, 3]);
  assert.deepEqual([M.pageOf([], 1, 30).from, M.pageOf([], 1, 30).pages], [0, 1]);
});

console.log(`\n${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
