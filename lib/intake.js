// 雇用・育成マスターの読み取りと検証。
//
// ■ この仕組みで一番危ないところ
//   1行のミスが、人事データと4システムぶんのアカウントを同時に生む。
//   間違ったメールアドレスで作ったアカウントは、消しても
//   無限道場・タイムカード・会計に痕跡が残る。
//
//   だから「読む」「検証する」「登録する」を分け、
//   検証の結果を人が見てから登録する2段構えにしてある。
//   このファイルは前半（読む・検証する）だけを持ち、DBには触らない。
//
// ■ 一部エラーでも全件止めない（§11）
//   10行のうち2行が駄目なとき、8行は登録する。
//   全部やり直しになると、結局手作業のほうが速くなる。
//
// ■ 見出しの表記ゆれを吸収する
//   管理者が作る表なので、列名は英語のフィールド名でも日本語でもよい。
//   ここで受け止めないと、雛形からずれた瞬間に取り込めなくなる。

import { JOB_CODES } from "./job-templates.js";

export const CONTRACT_TYPES = ["無期", "有期"];
export const WORK_STYLES = ["リモート", "ハイブリッド", "出社"];
export const ACCOUNT_TYPES = ["member", "manager"];

/**
 * マスターの標準項目（§4）。
 * label は雛形の見出し、aliases は表記ゆれの受け皿。
 */
export const FIELDS = [
  { key: "employee_code",  label: "社員コード",     required: false, aliases: ["社員番号", "employee code", "code"] },
  { key: "name",           label: "氏名",           required: true,  aliases: ["名前", "display_name", "社員名"] },
  { key: "login_email",    label: "ログインメール", required: true,  aliases: ["メール", "email", "mail", "メールアドレス"] },
  { key: "join_date",      label: "入社日",         required: true,  aliases: ["入社", "joined_on", "join date"] },
  { key: "contract_type",  label: "契約形態",       required: true,  aliases: ["無期/有期", "契約区分", "contract type"] },
  { key: "contract_end_date", label: "契約終了日",  required: false, aliases: ["契約満了日", "終了日", "contract end date"] },
  { key: "probation_months",  label: "試用期間(月)", required: false, aliases: ["試用期間", "probation"] },
  { key: "training_months",   label: "育成期間(月)", required: true,  aliases: ["育成期間", "training"] },
  { key: "weekly_hours",   label: "週所定労働時間", required: true,  aliases: ["週労働時間", "所定労働時間", "weekly hours"] },
  { key: "work_style",     label: "勤務形態",       required: false, aliases: ["働き方", "work style"] },
  { key: "job_family_code", label: "職種コード",    required: true,  aliases: ["職種", "job family", "job"] },
  { key: "initial_role",   label: "初期Role",       required: true,  aliases: ["役割", "role", "担当"] },
  { key: "work_scope",     label: "主な業務範囲",   required: false, aliases: ["業務範囲", "業務", "scope"] },
  { key: "manager_email",  label: "管理責任者メール", required: true, aliases: ["上長メール", "上長", "manager", "責任者"] },
  { key: "training_program_code", label: "研修",    required: false, aliases: ["研修コード", "training program", "無限道場"] },
  { key: "autonomy_level_start",  label: "開始レベル", required: true, aliases: ["自走レベル", "レベル", "autonomy", "level"] },
  { key: "three_month_goal", label: "3か月目標",    required: false, aliases: ["3ヶ月目標", "three month goal", "kgi"] },
  { key: "kpi_template_code", label: "KPIテンプレート", required: false, aliases: ["テンプレート", "kpi template"] },
  { key: "account_type",   label: "権限",           required: true,  aliases: ["アカウント種別", "account type", "member/manager"] },
  { key: "notes",          label: "備考",           required: false, aliases: ["メモ", "note", "notes"] },
];

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s　_()（）]/g, "");

/** 見出しの1行から、列番号 → フィールド名 の対応を作る */
export function mapHeader(header) {
  const map = {};
  const unknown = [];

  header.forEach((cell, i) => {
    const c = norm(cell);
    if (!c) return;
    const f = FIELDS.find((f) =>
      norm(f.key) === c || norm(f.label) === c || f.aliases.some((a) => norm(a) === c));
    if (f) map[f.key] = i;
    else unknown.push(String(cell).trim());
  });

  const missing = FIELDS.filter((f) => f.required && map[f.key] === undefined).map((f) => f.label);
  return { map, unknown, missing };
}

/** 表（2次元配列）を、1行1オブジェクトに直す */
export function toRows(table) {
  const rows = (table || []).filter((r) => r.some((c) => String(c ?? "").trim()));
  if (!rows.length) return { header: [], rows: [], ...mapHeader([]) };

  const header = rows[0];
  const h = mapHeader(header);
  const out = rows.slice(1).map((cells, i) => {
    const o = { _row: i + 2 };   // 表計算の行番号に合わせる（1行目が見出し）
    for (const [key, idx] of Object.entries(h.map)) {
      o[key] = String(cells[idx] ?? "").trim();
    }
    return o;
  });
  return { header, rows: out, ...h };
}

// -----------------------------------------------------------------------------
// 値の読み取り
// -----------------------------------------------------------------------------

/**
 * 日付。表計算から来る値は形がばらつく。
 *   2026-09-07 / 2026/9/7 / 45907（Excelのシリアル値）
 * どれも受けないと、管理者は「なぜか入らない」に当たる。
 */
export function readDate(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;

  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return iso(y, m, d);
  }
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split("/").map(Number);
    return iso(y, m, d);
  }
  // Excel のシリアル値。1900年うるう年バグを含む既定の基準日で戻す
  if (/^\d{5}$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function iso(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // 2026-02-31 のような、月をまたぐ日付を弾く
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

const readNum = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** 「バックオフィス、営業支援 / EC」のような書き方を配列にする */
const readList = (v) =>
  String(v ?? "").split(/[、,／/・|]/).map((s) => s.trim()).filter(Boolean).slice(0, 12);

// -----------------------------------------------------------------------------
// 検証（§9 §10）
// -----------------------------------------------------------------------------

/**
 * 1行を検証して、登録に使える形にそろえる。
 * DBには触らない。重複の確認は呼び出し側（既存の名簿と突き合わせる）。
 *
 * @returns {{ok:boolean, value?:object, errors?:Array<{field,message}>}}
 */
export function validateRow(raw) {
  const e = [];
  const bad = (field, message) => e.push({ field, message });

  const name = String(raw.name ?? "").trim();
  if (!name) bad("氏名", "空です");

  const email = String(raw.login_email ?? "").trim().toLowerCase();
  if (!email) bad("ログインメール", "空です");
  // ここは厳しくしすぎない。実在確認はできないので、明らかな形の誤りだけ弾く
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad("ログインメール", `「${email}」はメールの形になっていません`);

  const join = readDate(raw.join_date);
  if (!String(raw.join_date ?? "").trim()) bad("入社日", "空です");
  else if (!join) bad("入社日", `「${raw.join_date}」を日付として読めません（2026-09-07 の形で入れてください）`);

  const contract = String(raw.contract_type ?? "").trim();
  if (!contract) bad("契約形態", "空です");
  else if (!CONTRACT_TYPES.includes(contract)) bad("契約形態", `「${contract}」は使えません（無期 / 有期）`);

  // 有期なら終了日が要る（§9 条件付き）
  let end = null;
  if (contract === "有期") {
    const s = String(raw.contract_end_date ?? "").trim();
    if (!s) bad("契約終了日", "有期契約なので必須です");
    else {
      end = readDate(s);
      if (!end) bad("契約終了日", `「${s}」を日付として読めません`);
      else if (join && end <= join) bad("契約終了日", "入社日より後の日付にしてください");
    }
  }

  const training = readNum(raw.training_months);
  if (!String(raw.training_months ?? "").trim()) bad("育成期間(月)", "空です");
  else if (!(training >= 1 && training <= 24)) bad("育成期間(月)", `「${raw.training_months}」は1〜24の数字で入れてください`);

  const probation = readNum(raw.probation_months);
  if (String(raw.probation_months ?? "").trim() && !(probation >= 0 && probation <= 24)) {
    bad("試用期間(月)", `「${raw.probation_months}」は0〜24の数字で入れてください`);
  }

  const hours = readNum(raw.weekly_hours);
  if (!String(raw.weekly_hours ?? "").trim()) bad("週所定労働時間", "空です");
  else if (!(hours > 0 && hours <= 60)) bad("週所定労働時間", `「${raw.weekly_hours}」は1〜60の数字で入れてください`);

  const job = String(raw.job_family_code ?? "").trim().toUpperCase();
  if (!job) bad("職種コード", "空です");
  else if (!JOB_CODES.includes(job)) bad("職種コード", `「${job}」は使えません（${JOB_CODES.join(" / ")}）`);

  const role = String(raw.initial_role ?? "").trim();
  if (!role) bad("初期Role", "空です");

  const managerEmail = String(raw.manager_email ?? "").trim().toLowerCase();
  if (!managerEmail) bad("管理責任者メール", "空です");

  const level = readNum(String(raw.autonomy_level_start ?? "").replace(/^L/i, ""));
  if (!String(raw.autonomy_level_start ?? "").trim()) bad("開始レベル", "空です");
  else if (![1, 2, 3, 4].includes(level)) bad("開始レベル", `「${raw.autonomy_level_start}」は L1〜L4 のいずれかにしてください`);

  const account = String(raw.account_type ?? "").trim().toLowerCase();
  if (!account) bad("権限", "空です");
  else if (!ACCOUNT_TYPES.includes(account)) bad("権限", `「${account}」は使えません（member / manager）`);

  const style = String(raw.work_style ?? "").trim();
  if (style && !WORK_STYLES.includes(style)) {
    bad("勤務形態", `「${style}」は使えません（${WORK_STYLES.join(" / ")}）`);
  }

  if (e.length) return { ok: false, errors: e };

  return {
    ok: true,
    value: {
      employee_code: String(raw.employee_code ?? "").trim() || null,
      name,
      login_email: email,
      join_date: join,
      contract_type: contract,
      contract_end_date: end,
      probation_months: probation ?? null,
      training_months: training,
      weekly_hours: hours,
      work_style: style || null,
      job_family_code: job,
      initial_role: role,
      work_scope: readList(raw.work_scope),
      manager_email: managerEmail,
      training_programs: readList(raw.training_program_code),
      autonomy_level_start: level,
      three_month_goal: String(raw.three_month_goal ?? "").trim() || null,
      kpi_template_code: String(raw.kpi_template_code ?? "").trim().toUpperCase() || job,
      account_type: account,
      notes: String(raw.notes ?? "").trim() || null,
    },
  };
}

/** 雛形の見出し行。画面のダウンロードで使う */
export const templateHeader = () => FIELDS.map((f) => f.label);

/** 雛形に入れる記入例。空の表を渡されても書き方が分からないため */
export const templateSample = () => [
  "", "今福 文菜", "fumina@example.com", "2026-09-07", "有期", "2027-09-06",
  "6", "3", "29", "ハイブリッド", "BACKOFFICE", "事業推進・バックオフィス担当",
  "バックオフィス、事業推進、営業支援、EC", "manager@example.com", "無限道場",
  "L1", "", "", "member", "",
];
