// 営業の案件（db/100_sales_deals.sql）
//
// ■ 案件と会社のステータス
//   案件の段階に合わせて、会社のステータスを「商談」「提案」「成約」へ進める（後ろへは戻さない）。
//   失注は会社に写さない。1社に案件が複数あるため、1件の失注で会社全体を失注にはしない。
//   その会社の案件がすべて失注になったときだけ、画面で「会社も失注にしますか」と聞く（決めるのは人）。
//
// ■ もとのアタック（approach_id）
//   案件を作った時点で、その会社に最後に送ったアタック。作ったあとは変えない（DB のトリガーでも止める）。
//   分析の「どの営業文・チャネル・担当から生まれた売上か」はこれで数える。

import { statusRank, todayJst, isUuid } from "./sales.js";

export const DEAL_STAGES = [
  { key: "meeting", label: "商談" },
  { key: "proposal", label: "提案" },
  { key: "negotiation", label: "最終調整" },
  { key: "won", label: "成約" },
  { key: "lost", label: "失注" },
];
export const DEAL_STAGE_KEYS = DEAL_STAGES.map((s) => s.key);
export const DEAL_STAGE_LABEL = Object.fromEntries(DEAL_STAGES.map((s) => [s.key, s.label]));
export const OPEN_DEAL_STAGES = ["meeting", "proposal", "negotiation"];

// 成約確率の既定値（%）。案件ごとに上書きしたものがあればそちらを使う。
// db/100 の gw_sales_deal_default_probability() と同じ値にする（test/salesapi.mjs で突き合わせている）。
// 履歴には、その時点で実際に使った確率（effective_probability）を DB が残すので、ここを変えても過去の見込は変わらない
export const DEFAULT_PROBABILITY = { meeting: 20, proposal: 50, negotiation: 80 };

export const DEAL_FIELDS = "id, tenant_id, company_id, approach_id, owner_id, title, service, stage, amount, probability, "
  + "expected_close_on, won_on, lost_on, lost_reason, note, created_at, updated_at";

export const AMOUNT_MAX = 100000000000;   // 1,000億円（DB の制約と同じ）

/** 使う成約確率（%）。進行中でなければ null */
export function probabilityOf(d) {
  if (!OPEN_DEAL_STAGES.includes(d.stage)) return null;
  return d.probability ?? DEFAULT_PROBABILITY[d.stage];
}

/** 見込受注額（円）。進行中で金額が決まっているものだけ */
export function expectedOf(d) {
  const p = probabilityOf(d);
  return p === null || d.amount == null ? 0 : Math.round((d.amount * p) / 100);
}

export function shapeDeal(d, nameOf = () => null) {
  return {
    id: d.id, companyId: d.company_id, approachId: d.approach_id || null,
    ownerId: d.owner_id || null, ownerName: nameOf(d.owner_id),
    title: d.title, service: d.service || null,
    stage: d.stage, stageLabel: DEAL_STAGE_LABEL[d.stage] || d.stage,
    open: OPEN_DEAL_STAGES.includes(d.stage),
    amount: d.amount == null ? null : Number(d.amount),
    probability: d.probability ?? null,                      // 案件ごとに上書きした値（無ければ null）
    probabilityUsed: probabilityOf({ ...d, amount: d.amount == null ? null : Number(d.amount) }),
    expected: expectedOf({ ...d, amount: d.amount == null ? null : Number(d.amount) }),
    expectedCloseOn: d.expected_close_on || null,
    wonOn: d.won_on || null, lostOn: d.lost_on || null, lostReason: d.lost_reason || null,
    note: d.note || null, createdAt: d.created_at, updatedAt: d.updated_at,
  };
}

/** 案件の段階に合わせた会社のステータス（失注は写さない＝null） */
export function companyStatusFor(stage) {
  if (stage === "meeting") return "meeting";
  if (stage === "proposal" || stage === "negotiation") return "proposal";
  if (stage === "won") return "won";
  return null;
}

/**
 * 会社のステータスを案件に合わせて進めるか。進めるなら新しいステータス、進めないなら null。
 * 後ろへは戻さない。営業禁止・対象外の会社は触らない（人が決めた状態を案件で上書きしない）
 */
export function advanceCompanyStatus(company, stage) {
  const next = companyStatusFor(stage);
  if (!next || company.ng_reason || company.status === "excluded") return null;
  if (company.status === next) return null;
  // 失注・再アタック待ちの会社に新しい案件が立ったら、商談以降へ戻す（rank が低いので自然に進む）
  return statusRank(next) > statusRank(company.status) ? next : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cleanText = (v, max) => {
  if (v === undefined) return undefined;
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/**
 * 画面から来た値を DB の列へ。{ value } か { error, hint }
 * create: 作るとき（title 必須・段階は進行中のものだけ）
 */
export function normalizeDeal(body, { create = false } = {}) {
  const v = {};
  const title = cleanText(body.title, 200);
  if (create && !title) return { error: "bad_title", hint: "案件名を入れてください" };
  if (title !== undefined) {
    if (!title) return { error: "bad_title", hint: "案件名を入れてください" };
    v.title = title;
  }
  const service = cleanText(body.service, 100);
  if (service !== undefined) v.service = service;

  if (body.amount !== undefined) {
    if (body.amount === null || body.amount === "") v.amount = null;
    else {
      const n = Number(String(body.amount).replace(/[,，円¥\s]/g, ""));
      if (!Number.isInteger(n) || n < 0 || n > AMOUNT_MAX) return { error: "bad_amount", hint: "金額は0円以上の整数（円）で入れてください" };
      v.amount = n;
    }
  }
  if (body.probability !== undefined) {
    if (body.probability === null || body.probability === "") v.probability = null;
    else {
      const n = Number(body.probability);
      if (!Number.isInteger(n) || n < 0 || n > 100) return { error: "bad_probability", hint: "成約確率は0〜100の整数（%）で入れてください" };
      v.probability = n;
    }
  }
  if (body.expectedCloseOn !== undefined) {
    if (!body.expectedCloseOn) v.expected_close_on = null;
    else if (!DATE_RE.test(body.expectedCloseOn)) return { error: "bad_date", hint: "成約見込み日が正しくありません" };
    else v.expected_close_on = body.expectedCloseOn;
  }
  if (body.stage !== undefined) {
    const ok = create ? OPEN_DEAL_STAGES : DEAL_STAGE_KEYS;
    if (!ok.includes(body.stage)) return { error: "bad_stage", hint: "段階が正しくありません" };
    v.stage = body.stage;
  }
  const lostReason = cleanText(body.lostReason, 500);
  if (lostReason !== undefined) v.lost_reason = lostReason;
  const note = cleanText(body.note, 2000);
  if (note !== undefined) v.note = note;
  if (body.ownerId !== undefined) {
    if (body.ownerId && !isUuid(body.ownerId)) return { error: "bad_owner", hint: "担当が正しくありません" };
    v.owner_id = body.ownerId || null;
  }
  return { value: v };
}

/**
 * 段階が変わるときの 成約日・失注日。成約は 0円より大きい金額が要る（DB の制約と同じ）
 * @returns {{ patch?: object, error?: string, hint?: string }}
 */
export function stageDates(before, patch, today = todayJst()) {
  const stage = patch.stage ?? before.stage;
  if (stage === before.stage && patch.stage === undefined) return { patch: {} };
  const amount = "amount" in patch ? patch.amount : before.amount;
  if (stage === "won") {
    // DB の制約と同じ：成約は 0円より大きい金額が要る（受注額に 0円・金額不明を混ぜない）
    if (amount == null || amount <= 0) return { error: "amount_required", hint: "成約にするには0円より大きい金額を入れてください" };
    return { patch: { won_on: before.won_on || today, lost_on: null, lost_reason: null } };
  }
  if (stage === "lost") return { patch: { lost_on: before.lost_on || today, won_on: null } };
  // 進行中へ戻す（成約・失注の取り消し）
  return { patch: { won_on: null, lost_on: null } };
}

/** その会社の案件がすべて失注か（1件以上あって、進行中・成約が無い） */
export function allLost(deals) {
  return deals.length > 0 && deals.every((d) => d.stage === "lost");
}
