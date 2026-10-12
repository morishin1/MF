// 採用HR：カジュアル面談のお礼＋無限道場体験のご案内（1通）と、体験状況の見せ方。純粋な関数（表・LMS には触らない）。
//
// ■ メール
//   標準の文面はここで持つ（db/124 のひな型の用途〔purpose〕を増やさないため。送る前に画面で直せる）。
//   本人専用の登録URLは {{無限道場体験URL}}、期限は {{体験URLの有効期限}}。どちらもサーバーが送る直前に差し込む
//   （画面には URL を出さない）。送った記録（gw_hr_mail_sends）の本文には URL を残さない（recordBody）。
//   期限は LMS の招待（expires_at）から作る。日数を文面に決め打ちしない。
//
// ■ 体験状況（LMS が正本。HR には保存しない）
//   未招待／招待済み／期限切れ／登録済み／体験中／完了。取れなかったときは「取得できません」（未完了と書かない）。
//   すでに無限道場のアカウントがある人（受講生として登録済み・体験版は未参加）は「アカウントあり」。
//   この人には登録URLではなく参加用URL（ログインして［このコースに参加する］）を送る。新しいアカウントは作らず、
//   これまでの学習の記録・パスワードはそのまま（LMS の trial-invite allow_existing。文面は LMS_TRIAL_TEMPLATE_EXISTING）。
//   合否は決めない（体験の完了は採用の合格ではない）。

export const LMS_TRIAL_MAIL_NAME = "お礼＋無限道場体験のご案内";
export const TRIAL_URL_TAG = "{{無限道場体験URL}}";
export const TRIAL_EXPIRY_TAG = "{{体験URLの有効期限}}";
const NAME_TAG = "{{応募者名}}";
const URL_IN_RECORD = "［本人専用の体験登録URL（記録には残していません）］";

export const LMS_TRIAL_TEMPLATE = {
  subject: "【株式会社エイト】本日の面談のお礼と無限道場体験のご案内",
  body: [
    `${NAME_TAG} 様`,
    "",
    "本日はカジュアル面談のお時間をいただき、ありがとうございました。",
    "",
    "お話しした「無限道場」の体験版をご案内します。",
    "約45分で、ご自身の困りごとを整理し、生成AIを試しながら、小さな成果物を一つつくる内容です。",
    "",
    "▼無限道場 体験版（個別登録URL）",
    TRIAL_URL_TAG,
    `（このURLの有効期限：${TRIAL_EXPIRY_TAG}）`,
    "",
    "登録後、STEP0から始めてください。ご自身のペースで進められます。",
    "体験や継続受講の申し込みは、採用・契約の成立を意味しません。",
    "",
    "ご不明な点がありましたら、お気軽にご返信ください。",
    "",
    "株式会社エイト",
    "採用担当",
  ].join("\n"),
};

/** すでに無限道場のアカウントがある人むけ（ログインして参加。新しい登録は不要） */
export const LMS_TRIAL_TEMPLATE_EXISTING = {
  subject: LMS_TRIAL_TEMPLATE.subject,
  body: [
    `${NAME_TAG} 様`,
    "",
    "本日はカジュアル面談のお時間をいただき、ありがとうございました。",
    "",
    "お話しした「無限道場」の体験版をご案内します。",
    "約45分で、ご自身の困りごとを整理し、生成AIを試しながら、小さな成果物を一つつくる内容です。",
    "",
    "▼無限道場 体験版（参加用URL）",
    TRIAL_URL_TAG,
    `（このURLの有効期限：${TRIAL_EXPIRY_TAG}）`,
    "",
    "すでにお持ちの無限道場のアカウントでログインし、［このコースに参加する］を押してください。",
    "新しいアカウントの登録は不要です。これまでの学習の記録はそのまま残ります。",
    "参加後、STEP0から始めてください。ご自身のペースで進められます。",
    "体験や継続受講の申し込みは、採用・契約の成立を意味しません。",
    "",
    "ご不明な点がありましたら、お気軽にご返信ください。",
    "",
    "株式会社エイト",
    "採用担当",
  ].join("\n"),
};

const count = (text, tag) => String(text || "").split(tag).length - 1;

/**
 * 画面に出す下書き（氏名だけ入れる。URL・期限は送るときに入れる）
 * existing: すでに無限道場のアカウントがある人むけの文面（ログインして参加）
 */
export function trialDraft(applicant, { existing = false } = {}) {
  const name = String(applicant?.name || "").trim();
  const fill = (t) => (name ? t.split(NAME_TAG).join(name) : t);
  const tpl = existing ? LMS_TRIAL_TEMPLATE_EXISTING : LMS_TRIAL_TEMPLATE;
  return {
    subject: fill(tpl.subject),
    body: fill(tpl.body),
    existing: Boolean(existing),
    missing: name ? [] : [{ key: "応募者名", reason: "応募者の氏名が登録されていません" }],
  };
}

/**
 * 送る前の文面の確かめ（URL を受け取る前に断れるものだけ）。問題があれば理由の配列
 *   URL の差し込み位置が本文にちょうど1つあること・件名に URL を入れないこと
 */
export function trialMailProblems({ subject, body }) {
  const out = [];
  const n = count(body, TRIAL_URL_TAG);
  if (n === 0) out.push(`本文に ${TRIAL_URL_TAG} がありません（本人専用の登録URLを入れる場所です）`);
  if (n > 1) out.push(`${TRIAL_URL_TAG} は本文に1つだけにしてください`);
  if (count(subject, TRIAL_URL_TAG) || count(subject, TRIAL_EXPIRY_TAG)) out.push("件名に体験URL・有効期限は入れられません");
  return out;
}

/**
 * 差し込む。text は送る本文、recordBody は記録に残す本文（URL を伏せる）
 * @returns {{subject:string, text:string, recordBody:string}}
 */
export function fillTrialMail({ subject, body, name, url, expiresAt }) {
  const nm = String(name || "").trim();
  const expiry = formatExpiry(expiresAt) || "登録画面でご確認ください";
  const common = (t) => {
    let s = String(t || "");
    if (nm) s = s.split(NAME_TAG).join(nm);
    return s.split(TRIAL_EXPIRY_TAG).join(expiry);
  };
  const b = common(body);
  return { subject: common(subject), text: b.split(TRIAL_URL_TAG).join(String(url)), recordBody: b.split(TRIAL_URL_TAG).join(URL_IN_RECORD) };
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];
/** 日本時間「2026年10月19日（月）14:05まで」 */
export function formatExpiry(iso) {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return null;
  const j = new Date(t.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日（${WD[j.getUTCDay()]}）${p(j.getUTCHours())}:${p(j.getUTCMinutes())}まで`;
}

/** カジュアル面談を実施済みか（キャンセルしたものは数えない。lib/hr.js statusChangeWarnings と同じ見方） */
export const casualDone = (interviews) =>
  (interviews || []).some((i) => i.kind === "casual" && i.conducted_at && !i.canceled_at);

// ---- 体験状況 --------------------------------------------------------------------

export const TRIAL_STAGES = {
  none: "未招待", invited: "招待済み", expired: "招待の期限切れ", registered: "登録済み",
  account: "アカウントあり（体験版は未参加）", account_invited: "参加の案内済み（アカウントあり）",
  active: "体験中", done: "体験完了", unavailable: "取得できません",
};

/** LMS の trial-status の1件 → 段階 */
export function trialStage(item) {
  let key = "none";
  if (item?.completed) key = "done";
  else if (item?.started) key = "active";
  // アカウントはあるが体験版に参加していない（enrolled が無い古い LMS は、これまでどおり「登録済み」）
  else if (item?.registered && item.enrolled === false) key = item.invited && item.invite_status === "invited" ? "account_invited" : "account";
  else if (item?.registered) key = "registered";
  else if (item?.invited && item.invite_status === "expired") key = "expired";
  else if (item?.invited) key = "invited";
  return { key, label: TRIAL_STAGES[key] };
}

/** 画面に出す体験状況（本文・会話・点数は LMS から来ない。ここでも作らない） */
export function shapeTrialStatus(item) {
  const stage = trialStage(item);
  if (!item) return { stage, progress: null, conditions: [] };
  const lt = Number(item.lessons_total) || 0, ld = Number(item.lessons_done) || 0;
  return {
    stage,
    registered: Boolean(item.registered), enrolled: Boolean(item.enrolled),
    // 案内するなら参加用URL（ログインして参加）を使う人
    existing: stage.key === "account" || stage.key === "account_invited",
    progress: {
      percent: Math.max(0, Math.min(100, Number(item.progress_percent) || 0)),
      lessonsDone: ld, lessonsTotal: lt,
      invitedAt: item.invited_at || null, lastActivityAt: item.last_activity_at || null,
    },
    conditions: [
      { key: "lessons", label: "必須レッスン", done: lt > 0 && ld >= lt, detail: lt ? `${ld}/${lt}` : null },
      { key: "mvv", label: "考え方（MVV）への回答", done: Boolean(item.mvv_answered) },
      { key: "ai", label: "AIとのやり取り", done: Boolean(item.ai_tried) },
      { key: "challenge", label: "3分AIチャレンジ", done: Boolean(item.challenge_submitted) },
      { key: "output", label: "小さな成果物", done: Boolean(item.output_submitted) },
      { key: "reflection", label: "振り返り", done: Boolean(item.reflection_submitted) },
    ],
  };
}

/** LMS 呼び出しの失敗を、画面に出す説明へ（秘密・URL は入れない） */
export function lmsErrorHint(r) {
  if (!r || r.ok) return null;
  if (r.unreachable) return "無限道場に接続できませんでした（時間切れ・通信の失敗）。少し待ってからやり直してください";
  if (r.error === "not_configured") {
    return r.missing?.length
      ? `無限道場との連携の設定がありません（${r.missing.join("・")}）`
      : "無限道場の側に連携の設定（MUGENDOJO_HR_LMS_SECRET）がありません";
  }
  if (r.status === 401) return "無限道場に認証されませんでした（MF と無限道場の MUGENDOJO_HR_LMS_SECRET が同じか、サーバーの時刻を確かめてください）";
  if (r.error === "replayed_request") return "同じ要求が二度届いたため、無限道場が断りました。もう一度やり直してください";
  if (r.error === "trial_course_missing") return "無限道場に体験版のコースがありません（無限道場の管理画面で作成してください）";
  if (r.error === "invalid_allow_existing") return "無限道場がこの連携の形式に対応していません（無限道場を更新してください）";
  if (r.error === "invalid_email") return "応募者のメールアドレスの形が正しくありません";
  if (r.error === "lms_unavailable" || r.status === 503) return "無限道場が一時的に使えません。少し待ってからやり直してください";
  return `無限道場でエラーになりました（${String(r.error || r.status).slice(0, 40)}）`;
}
