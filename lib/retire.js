// 退職手続きと退職書類（db/121_retire_docs.sql）の、言葉・状態・見せ方。
//
// ■ 本人（退職者ポータル）に見せるのは、公開中の最新の版だけ
//   draft（下書き）・superseded（置き換え済み）・公開していない発行済みは、「準備中」として見せる
//   （下書きの存在や中身を、本人に知らせない）。
//     発行済みで公開中 → 発行済み（見る・保存する）
//     手続き中（processing）→ 手続き中（発行予定日があれば添える）
//     それ以外 → 準備中
//
// ■ 管理側が見る進み具合
//   退職日 → システム停止 → 退職証明書 → 源泉徴収票 → 離職票 → 健康保険 資格喪失証明書
//   「発行済み」になっているものを数える（公開は数えない。公開は本人に見せるかどうかの別の操作）

export const KINDS = [
  { key: "certificate",    label: "退職証明書",                 icon: "badge" },
  { key: "withholding",    label: "源泉徴収票",                 icon: "request_quote" },
  { key: "separation",     label: "離職票",                     icon: "assignment_return" },
  { key: "insurance_loss", label: "健康保険 資格喪失証明書",    icon: "health_and_safety" },
];
export const KIND_KEYS = KINDS.map((k) => k.key);
export const kindLabel = (k) => KINDS.find((x) => x.key === k)?.label || "書類";

/** 退職理由（構造化）。db/121 の check と同じ */
export const REASONS = [
  { key: "contract_end",   label: "契約期間満了" },
  { key: "personal",       label: "自己都合" },
  { key: "company",        label: "会社都合" },
  { key: "retirement_age", label: "定年" },
  { key: "other",          label: "その他" },
];
export const REASON_KEYS = REASONS.map((r) => r.key);
export const reasonLabel = (k) => REASONS.find((r) => r.key === k)?.label || "";

/** 本人に見せる状態 */
export const PORTAL_STATE = { issued: "issued", processing: "processing", preparing: "preparing" };

/** その種類の「いま有効な行」（置き換え済み以外のうち、いちばん新しい版） */
export function liveOf(docs, kind) {
  return (docs || [])
    .filter((d) => d.kind === kind && d.state !== "superseded")
    .sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null;
}

/**
 * 本人に見せる一覧。種類ごとに1行。公開中の発行済みだけ、見る・保存するができる。
 * 返すのは本人に見せてよい項目だけ（社内メモ・保存先・ハッシュ・本文は含めない）
 */
export function portalView(docs) {
  return KINDS.map((k) => {
    const d = liveOf(docs, k.key);
    if (d && d.state === "issued" && d.published) {
      return { kind: k.key, label: k.label, icon: k.icon, state: PORTAL_STATE.issued, id: d.id, issuedOn: d.issued_on || null, expectedOn: null };
    }
    if (d && d.state === "processing") {
      return { kind: k.key, label: k.label, icon: k.icon, state: PORTAL_STATE.processing, id: null, issuedOn: null, expectedOn: d.expected_on || null };
    }
    return { kind: k.key, label: k.label, icon: k.icon, state: PORTAL_STATE.preparing, id: null, issuedOn: null, expectedOn: d?.expected_on || null };
  });
}

/** 管理側に見せる状態（種類ごと） */
export function adminState(d) {
  if (!d) return "none";                                       // 未登録
  if (d.state === "processing") return "processing";           // 手続き中
  if (d.state === "draft") return "draft";                     // 下書き
  if (d.state === "issued") return d.published ? "published" : "issued";   // 発行済み（公開中／未公開）
  return "none";
}

/**
 * 退職手続きの進み具合（管理側）。
 * @param {{status?:string, left_on?:string|null}} employee
 * @param {object[]} docs
 */
export function progressOf(employee, docs) {
  const steps = [
    { key: "left_on", label: "退職日", done: Boolean(employee?.left_on) },
    { key: "systems", label: "システム停止", done: employee?.status === "left" },
    ...KINDS.map((k) => {
      const d = liveOf(docs, k.key);
      return { key: k.key, label: k.label, done: Boolean(d && d.state === "issued") };
    }),
  ];
  return { done: steps.filter((s) => s.done).length, total: steps.length, steps };
}

/** 退職書類の置き場所（private バケット hr）。公開URLは作らない */
export const retirePath = (tenantId, employeeId, kind, uuid, ext = "pdf") =>
  `${tenantId}/retire/${employeeId}/${kind}/${uuid}.${ext}`;

/** 保存先のパスが、その人・その種類の置き場所か（置き場所を自分で指定して他人のファイルを掴ませない） */
export function ownsPath(path, tenantId, employeeId, kind) {
  const prefix = `${tenantId}/retire/${employeeId}/${kind}/`;
  return typeof path === "string" && path.startsWith(prefix) && /^[\w-]+\.pdf$/.test(path.slice(prefix.length));
}

/** 本人に渡すファイル名（日本語。拡張子は pdf） */
export function downloadName(kind, employeeName, issuedOn) {
  const clean = (s) => String(s || "").replace(/[\\/:*?"<>|\r\n]/g, "").trim();
  const d = String(issuedOn || "").replace(/-/g, "");
  return `${clean(kindLabel(kind))}${employeeName ? `_${clean(employeeName)}` : ""}${d ? `_${d}` : ""}.pdf`;
}

/** 発行番号 RET-2026-0012 */
export const issuedNo = (year, n) => `RET-${year}-${String(n).padStart(4, "0")}`;
