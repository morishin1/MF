// オリエンテーション（入社前に読んでもらうもの）。
//
// ■ 何を登録できるか
//   動画・PDF・リンク・本文。会社説明、就業ルール、勤怠の付け方、情報セキュリティ、
//   設備、PC/Slack の使い方など。管理者が admin-hr.html の中で登録する。
//
// ■ 「確認済み」は本人が押す
//   読んだかどうかを機械で測らない（動画の再生時間を取るような仕組みは作らない）。
//   本人が「確認しました」を押した時刻を残すだけ。
//   同意書類（lib/consent-docs.js）と違って、版は持たない。
//   内容が大きく変わって読み直しが要るなら、新しい項目として登録する。
//
// ■ 段階との関係
//   必須の項目がすべて確認済みになるまで、本人の STEP 2 は終わらない。
//   管理者の段階（④）の blockers にも出る（lib/onboard-stage.js の orientationOk）。
//   項目が1つも登録されていなければ、無いものとして通す。

export const ORIENTATION_KINDS = [
  { key: "video", label: "動画",        icon: "play_circle" },
  { key: "pdf",   label: "PDF",         icon: "picture_as_pdf" },
  { key: "link",  label: "リンク",      icon: "link" },
  { key: "text",  label: "本文（社内ルール等）", icon: "article" },
];
export const ORIENTATION_KIND_KEYS = ORIENTATION_KINDS.map((k) => k.key);

const str = (v, max) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/**
 * 画面から来た値を、保存できる形にそろえる。
 * @returns {{ value?: object, error?: string, hint?: string }}
 */
export function normalizeItem(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body?.title !== undefined) {
    out.title = str(body?.title, 120);
    if (!out.title) return { error: "invalid_body", hint: "題名を入れてください" };
  }
  if (!partial || body?.kind !== undefined) {
    out.kind = ORIENTATION_KIND_KEYS.includes(body?.kind) ? body.kind : "link";
  }
  if (!partial || body?.url !== undefined) {
    const u = str(body?.url, 1000);
    // 外部の動画・PDF・ページ。https 以外は受けない（javascript: などを画面に出さないため）
    if (u && !/^https:\/\//i.test(u)) return { error: "invalid_body", hint: "URL は https:// から始めてください" };
    out.url = u;
  }
  if (!partial || body?.body !== undefined) out.body = str(body?.body, 20000);
  if (!partial || body?.description !== undefined) out.description = str(body?.description, 600);
  if (!partial || body?.required !== undefined) out.required = body?.required !== false;
  if (!partial || body?.sortOrder !== undefined) {
    const n = Number(body?.sortOrder);
    out.sort_order = Number.isFinite(n) ? Math.max(0, Math.min(9999, Math.round(n))) : 100;
  }
  if (partial && body?.active !== undefined) out.active = body.active !== false;

  const kind = out.kind ?? body?.kind;
  if (!partial) {
    if (kind === "text" && !out.body) return { error: "invalid_body", hint: "本文を入れてください" };
    if (kind !== "text" && !out.url) return { error: "invalid_body", hint: "URL を入れてください" };
  }
  return { value: out };
}

/**
 * 本人の確認の状態を、項目ごとに付ける。
 * @param {object[]} items  gw_orientation_items（active）
 * @param {object[]} checks gw_orientation_checks（その人の）
 */
export function orientationState(items, checks) {
  const at = new Map((checks || []).map((c) => [c.item_id, c.confirmed_at]));
  return (items || [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100) || String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .map((i) => ({
      id: i.id, title: i.title, kind: i.kind,
      kindLabel: ORIENTATION_KINDS.find((k) => k.key === i.kind)?.label || i.kind,
      url: i.url || null, body: i.body || null, description: i.description || null,
      required: i.required !== false,
      confirmed: at.has(i.id),
      confirmedAt: at.get(i.id) || null,
    }));
}

/** 必須の項目がすべて確認済みか。項目が無ければ true */
export const orientationDone = (items, checks) =>
  orientationState(items, checks).filter((i) => i.required).every((i) => i.confirmed);
