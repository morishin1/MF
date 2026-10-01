// 労働条件通知書（入社予定者が閲覧・確認する書類）の、決まりと判定。純粋関数（表は読まない）。
//
// ■ 何をするものか
//   会社が労働条件通知書のPDFをアップロードして本人に公開 → 本人が /onboarding/ で見て「確認しました」。
//   電子署名ではない。「本人が内容を見て確認した事実（日時）」を残すだけ。
//
// ■ 1行＝1版（db/110_labor_notices.sql）
//   差し替えは、上書きせず新しい版（version+1）を足す。古い版は消さない。
//   本人に見せるのは「公開済みの、いちばん新しい版」だけ。確認も、その版に付く。
//   新しい版を公開すると、その版は未確認から始まる（確認済み → 未確認に戻る）。
//   公開前の新しい版（下書き）があっても、公開するまでは、本人には前の版が見える。
//
// ■ 電子署名との関係（別の事実として扱う）
//   「通知書を確認した」と「電子署名した」は別。確認ボタンで gw_sign_requests は書き換えない。
//   その人に有効な電子署名依頼（gw_sign_requests・取り消し以外）があるあいだは、電子署名のほうを優先し、
//   通知書の確認では、STEP2（雇用契約）を完了にしない（mode: "esign"）。
//
// ■ 状態
//   管理側  none（未登録）/ draft（アップロード済み・未公開）/ unconfirmed（公開済み・本人未確認）/ confirmed（確認済み）
//   本人側  none（会社が準備中）/ unconfirmed（確認してください）/ confirmed（確認済み）/ esign（電子署名で進める）
//
// ■ 管理できる人（給与・個人情報を含む書類なので、絞る）
//   owner ロール・hr ロールを持つ人だけ。会計側の管理者（admin / staff）・経理・責任者・採用担当・営業・社労士は含めない。
//   DB 側（db/110 の RLS）も同じ条件（gw_has_role の owner / hr）。ここを変えるときは、そちらも合わせる。
//   本人は、管理側ではなく本人の入口（api/onboarding/start.js）で、自分の公開済みの最新版だけを見る。

export const NOTICE_BUCKET = "hr";
/** 閲覧用の署名付きURLの有効時間（秒） */
export const NOTICE_TTL = 60 * 5;
export const NOTICE_MAX_BYTES = 15 * 1024 * 1024;
export const NOTICE_TITLE = "労働条件通知書";

export const ADMIN_STATUS = {
  none: "未登録",
  draft: "未公開",
  unconfirmed: "本人未確認",
  confirmed: "確認済み",
};

/** 通知書を管理できるロール。会計側の管理者（isAdmin）・canManageHr は使わない */
export const NOTICE_MANAGER_ROLES = ["owner", "hr"];

/**
 * 通知書を管理（アップロード・プレビュー・公開・状況の閲覧）できるか。
 * ctx.roles（gw_role_grants）に owner か hr がある人だけ。ctx.isAdmin（会計側の admin / staff）は見ない。
 */
export const canManageNotice = (ctx) =>
  Array.isArray(ctx?.roles) && NOTICE_MANAGER_ROLES.some((r) => ctx.roles.includes(r));

/** Storage のパス。<tenant>/labor-notice/<employee>/<uuid>.pdf（上書きしない・版ごとに別のファイル） */
export const noticePrefix = (tenantId, employeeId) => `${tenantId}/labor-notice/${employeeId}/`;

/** 置かれたパスが、この会社・この人のものか（他人・他社のファイルを掴ませない） */
export function isNoticePath(path, tenantId, employeeId) {
  const prefix = noticePrefix(tenantId, employeeId);
  const p = String(path || "");
  if (!tenantId || !employeeId || !p.startsWith(prefix)) return false;
  return /^[0-9a-f-]{36}\.pdf$/i.test(p.slice(prefix.length));
}

/** 先頭が %PDF- か。拡張子も Content-Type も名乗るだけなので、中身を見る */
export const isPdfBytes = (bytes) => {
  const b = Buffer.from(bytes || []);
  return b.length > 4 && b.subarray(0, 5).toString("latin1") === "%PDF-";
};

const NOT_PDF = { ok: false, error: "not_pdf", hint: "PDFのみアップロードできます" };
const TOO_BIG = { ok: false, error: "file_too_large", hint: "ファイルは15MBまでにしてください" };

/** アップロード前の申告（置き場所を出す前に弾く） */
export function checkDeclared({ mimeType, sizeBytes } = {}) {
  if (String(mimeType || "application/pdf") !== "application/pdf") return { ...NOT_PDF, error: "unsupported_mime" };
  if (!(Number(sizeBytes) > 0)) return { ok: false, error: "no_file", hint: "ファイルを選んでください" };
  if (Number(sizeBytes) > NOTICE_MAX_BYTES) return TOO_BIG;
  return { ok: true };
}

/** 置かれた実体の確認 */
export function checkBytes(bytes) {
  const n = bytes?.length || 0;
  if (!n) return { ok: false, error: "no_file", hint: "ファイルを選んでください" };
  if (n > NOTICE_MAX_BYTES) return TOO_BIG;
  if (!isPdfBytes(bytes)) return NOT_PDF;
  return { ok: true };
}

/** ファイル名を、表示とダウンロードに使える形に（パス区切り・制御文字を落とす） */
export const cleanFilename = (s) =>
  String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 160) || "労働条件通知書.pdf";

const byVersionDesc = (a, b) => Number(b.version) - Number(a.version);

/** 版の新しい順。 */
export const sortVersions = (rows) => [...(rows || [])].sort(byVersionDesc);

/** 本人に見せる版。公開済みで、いちばん新しい版。無ければ null */
export const currentOf = (rows) => sortVersions(rows).find((r) => r.published_at) || null;

/** 公開待ちの版。いちばん新しい版が未公開で、公開済みの版より新しいとき。無ければ null */
export function pendingOf(rows) {
  const top = sortVersions(rows)[0] || null;
  if (!top || top.published_at) return null;
  return top;
}

/** 次の版番号 */
export const nextVersion = (rows) => Math.max(0, ...((rows || []).map((r) => Number(r.version) || 0))) + 1;

/** 公開してよい行か（いちばん新しい版で、まだ公開していない） */
export function canPublish(rows, id) {
  const top = sortVersions(rows)[0] || null;
  if (!top || top.id !== id) return { ok: false, reason: "not_latest", hint: "いちばん新しい版だけを公開できます" };
  if (top.published_at) return { ok: false, reason: "already_published", hint: "この版はもう公開しています" };
  return { ok: true };
}

/**
 * 管理側の状態。
 * @param {object[]} rows  gw_labor_notices の、その人の行（順不同）
 * @param {{esign?:boolean}} o  esign … 有効な電子署名依頼がある（確認では締結扱いにしない）
 */
export function adminState(rows, { esign = false } = {}) {
  const current = currentOf(rows);
  const pending = pendingOf(rows);
  let status = "none";
  if (current) status = current.confirmed_at ? "confirmed" : "unconfirmed";
  else if (pending) status = "draft";
  return {
    mode: esign ? "esign" : "notice",
    status, statusLabel: ADMIN_STATUS[status],
    // 公開済みの版があり、さらに新しい下書きがあるとき（差し替えの途中）
    replacing: Boolean(current && pending),
    current, pending, versions: sortVersions(rows),
  };
}

/**
 * 本人側の状態。公開済みの最新版だけを見せる（下書き・古い版は出さない）。
 * @returns {{mode:"notice"|"esign", state:"none"|"unconfirmed"|"confirmed"|"esign",
 *            version:number|null, publishedAt:string|null, confirmedAt:string|null, filename:string|null}}
 */
export function selfState(rows, { esign = false } = {}) {
  const c = currentOf(rows);
  if (esign) return { mode: "esign", state: "esign", version: null, publishedAt: null, confirmedAt: null, filename: null };
  if (!c) return { mode: "notice", state: "none", version: null, publishedAt: null, confirmedAt: null, filename: null };
  return {
    mode: "notice", state: c.confirmed_at ? "confirmed" : "unconfirmed",
    version: Number(c.version), publishedAt: c.published_at, confirmedAt: c.confirmed_at || null, filename: c.filename || null,
  };
}

/**
 * 確認しました、を押してよいか。
 *   ・電子署名の依頼があるあいだは押せない（電子署名のほうを優先する）
 *   ・公開済みの最新版だけ。読んでいるあいだに差し替えられたら、読み直してもらう
 *   ・すでに確認した版は、成功として返す（二重押し）。最初の確認日時を残す
 */
export function canConfirm(rows, version, { esign = false } = {}) {
  if (esign) return { ok: false, reason: "esign_in_progress", hint: "この方には電子署名の依頼があります。電子署名で進めてください" };
  const c = currentOf(rows);
  if (!c) return { ok: false, reason: "not_published", hint: "労働条件通知書は、まだ届いていません" };
  if (Number(version) !== Number(c.version)) {
    return { ok: false, reason: "version_changed", hint: "労働条件通知書が更新されました。もう一度、内容をご確認ください" };
  }
  if (c.confirmed_at) return { ok: true, already: true, row: c };
  return { ok: true, already: false, row: c };
}

/**
 * 入社手続きの段階判定（lib/onboard-stage.js）に渡す「事実」。
 * 電子署名の依頼がある人は、ここでは渡さない（呼ぶ側が esign を見て捨てる）。
 * @returns {{published:boolean, confirmed:boolean, version:number|null, hasAny:boolean}}
 */
export function noticeFact(rows) {
  const c = currentOf(rows);
  return {
    published: Boolean(c), confirmed: Boolean(c?.confirmed_at),
    version: c ? Number(c.version) : null, hasAny: Boolean((rows || []).length),
  };
}

/**
 * 一覧・経営ハブ用の1行。電子署名・作成依頼の流れにある人は、通知書の対象に数えない。
 * @param {object} fact  noticeFact の結果 | null（表が読めない）
 * @param {{esign?:boolean, order?:boolean}} o
 * @returns {"na"|"unlinked"|"none"|"draft"|"unconfirmed"|"confirmed"}
 */
export function listStatus(fact, { esign = false, order = false } = {}) {
  if (!fact) return "unlinked";
  if (esign) return "na";
  if (fact.published) return fact.confirmed ? "confirmed" : "unconfirmed";
  if (order) return "na";
  return fact.hasAny ? "draft" : "none";
}
