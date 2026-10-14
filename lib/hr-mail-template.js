// 採用HR：応募者へ送るメールのひな型（db/124）。差し込み・予約URLの選び方・送る前の確かめ。純粋な関数（表は読まない）。
//
// ■ 差し込み項目（この5つだけ。ほかの {{…}} は置き換えない＝未置換として送らせない）
//   {{応募者名}}     … 応募者の氏名（敬称なし。本文側で「様」を付ける）
//   {{募集職種}}     … 応募職種（gw_hr_applicants.job_title）
//   {{面談予約URL}}  … 用途に合う TimeRex の予約URL ＋ この応募者の ID（lib/hr.js schedulingUrlFor。サーバーで付ける）
//   {{担当者名}}     … 応募者の採用担当（無ければ、送る人）
//   {{会社名}}       … 登録済みの会社名（tenants.name）
//
// ■ 予約URLは用途で選ぶ。設定が無ければ「不足」（別の予約先で代用しない）
//   応募受付・カジュアル面談 → カジュアル面談の予約枠（無限道場のリードは、無限道場の予約枠）
//   社長面談               → 社長面談の予約枠（無限道場のリードには無い）
//   その他                 → 予約先なし
//
// ■ 差し込みは1回だけ（差し込んだ値の中の {{…}} を、もう一度置き換えない）。件名に入る値は改行を取り除く

import { schedulingUrlFor } from "./hr.js";
import { isMugendojo } from "./hr-lead-flow.js";

export const MAIL_FIELDS = [
  { key: "応募者名", hint: "敬称なし。本文で「様」を付けます" },
  { key: "募集職種", hint: "応募職種" },
  { key: "面談予約URL", hint: "用途に合う予約URL（この応募者専用）" },
  { key: "担当者名", hint: "採用担当（未設定なら送る人）" },
  { key: "会社名", hint: "登録済みの会社名" },
];
export const MAIL_FIELD_KEYS = MAIL_FIELDS.map((f) => f.key);

export const PURPOSES = [
  { key: "application", label: "応募受付／カジュアル面談案内", booking: "casual" },
  { key: "casual",      label: "カジュアル面談案内",           booking: "casual" },
  { key: "ceo",         label: "社長面談案内",                 booking: "ceo" },
  { key: "other",       label: "その他",                       booking: null },
];
export const PURPOSE_KEYS = PURPOSES.map((p) => p.key);
export const purposeLabel = (k) => PURPOSES.find((p) => p.key === k)?.label || "その他";

export const NAME_MAX = 80;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 8000;

/** 標準のひな型（テナントに無いときだけ1回入れる。担当者が直した・非表示にしたものは上書きしない） */
export const STANDARD_TEMPLATES = [{
  seedKey: "standard_application_v1",
  name: "応募受付・事前質問・面談案内",
  purpose: "application",
  subject: "ご応募ありがとうございます／事前質問とカジュアル面談のご案内",
  body: [
    "{{応募者名}} 様",
    "このたびは弊社の採用選考にご応募いただき、誠にありがとうございます。",
    "今後の選考をスムーズに進めるため、まずは以下の内容について、メール本文にてご返信をお願いいたします。",
    "【ご返信いただきたい内容】",
    "① 希望する雇用形態",
    "（正社員・業務委託・新卒・アルバイト等）",
    "※正社員以外をご希望の場合は、稼働可能な曜日・時間帯もご記載ください。",
    "② 希望する給与・報酬の目安",
    "③ ご自宅の最寄り駅",
    "（例：東京都・渋谷駅）",
    "④ 原宿オフィスへの出社可否",
    "（例：週1回出社可能、基本リモート希望 等）",
    "⑤ 募集職種に関連するご経験",
    "これまでの業務経験や、活かせるスキルなどをご記載ください。",
    "⑥ 自己PR",
    "簡単な内容で構いませんので、ご自身の強みや今後取り組みたいことなどをご記載ください。",
    "上記①〜⑥をご返信いただいた後、カジュアル面談の日程調整をお願いいたします。",
    "以下のURLより、ご都合の良い日時をお選びください。",
    "{{面談予約URL}}",
    "ご不明な点がございましたら、お気軽に採用担当までご連絡ください。",
    "それでは、ご返信をお待ちしております。",
    "{{会社名}}",
    "採用担当",
  ].join("\n"),
}];

/**
 * 用途に合う予約URL。設定が無い・この応募者には無い予約先なら url=null と理由（別の予約先で代用しない）
 * @param {string} purpose
 * @param {{id:string, lead_category?:string}} applicant
 * @param {object} env
 */
export function bookingUrlFor(purpose, applicant, env = process.env) {
  const booking = PURPOSES.find((p) => p.key === purpose)?.booking || null;
  if (!booking) return { url: null, envName: null, reason: "この用途には予約先がありません" };
  const lead = isMugendojo(applicant || {});
  if (booking === "ceo") {
    if (lead) return { url: null, envName: null, reason: "無限道場のリードには社長面談の予約先がありません" };
    const url = schedulingUrlFor(env.TIMEREX_CEO_INTERVIEW_URL, applicant?.id);
    return { url, envName: "TIMEREX_CEO_INTERVIEW_URL", reason: url ? null : "社長面談の予約URL（TIMEREX_CEO_INTERVIEW_URL）が未設定です" };
  }
  const envName = lead ? "TIMEREX_MUGENDOJO_CASUAL_URL" : "TIMEREX_CASUAL_INTERVIEW_URL";
  const url = schedulingUrlFor(env[envName], applicant?.id);
  return { url, envName, reason: url ? null : `カジュアル面談の予約URL（${envName}）が未設定です` };
}

/** その応募者・その用途の差し込み値。無いものは null（理由つき） */
export function mailValues({ applicant, purpose, companyName, ownerName, senderName, env = process.env }) {
  const booking = bookingUrlFor(purpose, applicant, env);
  const v = {
    応募者名: String(applicant?.name || "").trim() || null,
    募集職種: String(applicant?.job_title || "").trim() || null,
    面談予約URL: booking.url,
    担当者名: String(ownerName || senderName || "").trim() || null,
    会社名: String(companyName || "").trim() || null,
  };
  const why = {
    応募者名: "応募者の氏名が登録されていません",
    募集職種: "応募職種が登録されていません",
    面談予約URL: booking.reason,
    担当者名: "担当者の氏名が分かりません",
    会社名: "会社名が登録されていません",
  };
  return { values: v, reasons: why };
}

const TAG = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** 使われている差し込み項目（知っているものだけ）と、知らない {{…}} */
export function tagsIn(...texts) {
  const used = new Set(), unknown = new Set();
  for (const t of texts) for (const m of String(t || "").matchAll(TAG)) {
    (MAIL_FIELD_KEYS.includes(m[1]) ? used : unknown).add(m[1]);
  }
  return { used: [...used], unknown: [...unknown] };
}

/**
 * 差し込む（1回だけ。差し込んだ値の中はもう見ない）。値の無い項目は {{…}} のまま残し、missing に理由を入れる
 * @returns {{subject:string, body:string, missing:{key:string, reason:string}[], unknown:string[]}}
 */
export function renderMail(tpl, { values, reasons }) {
  const missing = new Map();
  const fill = (text, oneLine) => String(text || "").replace(TAG, (all, key) => {
    if (!MAIL_FIELD_KEYS.includes(key)) return all;
    const v = values[key];
    if (v == null || v === "") { missing.set(key, reasons[key] || "値がありません"); return all; }
    return oneLine ? String(v).replace(/[\r\n]+/g, " ") : String(v);
  });
  const subject = fill(tpl.subject, true);
  const body = fill(tpl.body, false);
  return { subject, body, missing: [...missing].map(([key, reason]) => ({ key, reason })), unknown: tagsIn(subject, body).unknown };
}

/**
 * 送る直前の確かめ（利用者が直した件名・本文）。問題があれば理由の配列
 *   未置換の {{…}}・件名の改行・長さ・他の応募者の予約URL（applicant_id が違う）
 */
export function sendProblems({ subject, body, applicantId }) {
  const out = [];
  const s = String(subject ?? ""), b = String(body ?? "");
  if (!s.trim()) out.push("件名が空です");
  if (/[\r\n]/.test(s)) out.push("件名に改行は使えません");
  if (s.length > SUBJECT_MAX) out.push(`件名は${SUBJECT_MAX}文字以内にしてください`);
  if (!b.trim()) out.push("本文が空です");
  if (b.length > BODY_MAX) out.push(`本文は${BODY_MAX}文字以内にしてください`);
  const left = [...`${s}\n${b}`.matchAll(TAG)].map((m) => `{{${m[1]}}}`);
  if (left.length) out.push(`差し込まれていない項目が残っています：${[...new Set(left)].join("・")}`);
  const ids = [...b.matchAll(/applicant_id=([0-9a-f-]{8,})/gi)].map((m) => m[1].toLowerCase());
  if (ids.some((id) => id !== String(applicantId || "").toLowerCase())) {
    out.push("ほかの応募者の予約URLが含まれています（この応募者のURLに差し替えてください）");
  }
  return out;
}

/** メールサービスの結果を、送れた／送れなかった／結果不明 に分ける（受け付け ≠ 到達・開封） */
export function sendOutcome(mail) {
  if (mail.status === "sent") return "sent";
  if (mail.status === "skipped") return "not_sent";
  // 時間切れ・通信の途中で切れた … 先方が受け付けたかどうか分からない
  if (/時間切れ|応答がありませんでした|fetch failed|ECONNRESET|socket|network/i.test(String(mail.error || ""))) return "unknown";
  return "failed";
}
