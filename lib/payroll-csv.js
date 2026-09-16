// マネーフォワード クラウド給与の「従業員」取込用 CSV。
//
// ■ 何を入れて、何を入れないか
//
//   入れる … 給与計算と社会保険の手続きに要るものだけ。
//            氏名・カナ・生年月日・入社日・住所・部署・雇用区分・
//            振込口座・基礎年金番号・雇用保険番号・扶養人数・通勤手当・メール
//   入れない … 電話番号・緊急連絡先・通勤経路・扶養家族の氏名や生年月日・
//              自己紹介・マイナンバー（そもそも持っていない）・提出書類
//
//   「あると便利」で列を足さない。CSV は手元に残りやすく、
//   消し忘れたファイルに個人情報が乗り続けるのが、いちばん多い漏れ方。
//
// ■ 列の並び
//
//   MF給与の取込画面は「項目の対応付け」を人が指定できる。
//   ここでは MF給与の項目名にそろえた見出しにしてあるが、版が変わっても
//   見出しで対応付ければ通る。見出しを変えたいときは COLUMNS だけを直す。
//
// ■ 文字コード
//
//   UTF-8（BOM 付き）。Excel でそのまま開ける。
//   MF給与の取込で文字化けするときは、取込画面で「UTF-8」を選ぶ。

/** 氏名を姓と名に分ける。全角・半角の空白どちらでも。空白が無ければ全部を姓に */
export function splitName(s) {
  const t = String(s ?? "").trim().replace(/[　]+/g, " ");
  if (!t) return ["", ""];
  const i = t.indexOf(" ");
  if (i < 0) return [t, ""];
  return [t.slice(0, i), t.slice(i + 1).trim()];
}

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? "")) ? String(v).slice(0, 10).replace(/-/g, "/") : "");
const num = (v) => (v === null || v === undefined || v === "" ? "" : String(Number(v)));

/**
 * 列の定義。MF給与の項目名にそろえる。
 * pick は { employee, profile, contract } から値を出す
 */
export const COLUMNS = [
  { header: "従業員番号",           pick: ({ employee }) => employee.employee_code || "" },
  { header: "姓",                   pick: ({ employee }) => splitName(employee.display_name)[0] },
  { header: "名",                   pick: ({ employee }) => splitName(employee.display_name)[1] },
  { header: "姓（カナ）",           pick: ({ profile }) => splitName(profile.name_kana)[0] },
  { header: "名（カナ）",           pick: ({ profile }) => splitName(profile.name_kana)[1] },
  { header: "生年月日",             pick: ({ profile }) => ymd(profile.birth_date) },
  { header: "入社日",               pick: ({ employee }) => ymd(employee.joined_on) },
  { header: "部署",                 pick: ({ employee }) => employee.department || "" },
  { header: "役職",                 pick: ({ employee }) => employee.position || "" },
  { header: "雇用形態",             pick: ({ employee }) => employee.employment_type || "" },
  { header: "メールアドレス",       pick: ({ employee }) => employee.email || "" },
  { header: "郵便番号",             pick: ({ profile }) => profile.postal_code || "" },
  { header: "住所",                 pick: ({ profile }) => profile.address || "" },
  { header: "給与形態",             pick: ({ contract }) => contract.wage_type || "" },
  { header: "基本給",               pick: ({ contract }) => num(contract.wage_amount) },
  { header: "通勤手当（月額）",     pick: ({ profile }) => num(profile.commute_cost) },
  { header: "振込先銀行名",         pick: ({ profile }) => profile.bank_name || "" },
  { header: "振込先支店名",         pick: ({ profile }) => profile.bank_branch || "" },
  { header: "預金種別",             pick: ({ profile }) => profile.bank_type || "" },
  { header: "口座番号",             pick: ({ profile }) => profile.bank_number || "" },
  { header: "口座名義（カナ）",     pick: ({ profile }) => profile.bank_holder || "" },
  { header: "基礎年金番号",         pick: ({ profile }) => profile.pension_number || "" },
  { header: "雇用保険被保険者番号", pick: ({ profile }) => profile.employment_ins_number || "" },
  { header: "扶養親族数",           pick: ({ profile }) =>
      String(profile.has_dependents ? (Array.isArray(profile.dependents) ? profile.dependents.length : 0) : 0) },
];
export const HEADERS = COLUMNS.map((c) => c.header);

/** 出さないと決めた欄。テストで「混ざっていない」ことを確かめる */
export const EXCLUDED_PROFILE_FIELDS = [
  "phone", "emg_name", "emg_relation", "emg_phone", "commute_from", "commute_route",
  "dependents_note", "greeting",
];

const cell = (v) => {
  const s = String(v ?? "");
  // 先頭が = + - @ のセルは、Excel が式として実行する。守りに ' を付ける
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * CSV 本文（BOM 付き UTF-8 の文字列）。
 * @param {Array<{employee:object, profile:object, contract:object}>} rows
 */
export function buildCsv(rows) {
  const lines = [HEADERS.map(cell).join(",")];
  for (const r of rows || []) {
    const ctx = { employee: r.employee || {}, profile: r.profile || {}, contract: r.contract || {} };
    lines.push(COLUMNS.map((c) => cell(c.pick(ctx))).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** ファイル名。日付と人数だけ。氏名は入れない（ファイル名は残りやすい） */
export const csvFileName = (today, n) => `mf_payroll_${String(today).replace(/-/g, "")}_${n}.csv`;
