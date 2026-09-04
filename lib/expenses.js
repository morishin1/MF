// 経費精算の共通処理。
//
// 承認経路の判定と明細の検証をここにまとめる。金額の扱いを1か所にして、
// 画面・API・CSV で計算がずれないようにする。

import { admin } from "./supabase.js";

export const MAX_LINES = 50;
export const MAX_AMOUNT = 10_000_000;  // 1明細の上限（誤入力よけ）
export const TAX_RATES = [0, 8, 10];

const DEFAULT_SETTINGS = {
  expense_owner_threshold: 100000,
  expense_categories: [
    "旅費交通費", "会議費", "交際費", "消耗品費", "新聞図書費",
    "通信費", "研修費", "支払手数料", "荷造運賃", "雑費",
  ],
};

/** 経費を承認・全件閲覧できる立場か（管理部＝管理者/人事、または経営者） */
export const canReviewExpense = (ctx) =>
  ctx.isAdmin || ctx.isHr || ctx.roles.includes("owner");

/**
 * 会社ごとのワークフロー設定。行が無ければ既定値を返す。
 * 016 未適用の環境でも落とさない（画面が真っ白になるより既定で動くほうがよい）。
 */
export async function loadWorkflowSettings(tenantId) {
  try {
    const { data } = await admin()
      .from("gw_workflow_settings")
      .select("expense_owner_threshold, expense_categories")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!data) return { ...DEFAULT_SETTINGS };
    return {
      expense_owner_threshold: data.expense_owner_threshold ?? DEFAULT_SETTINGS.expense_owner_threshold,
      expense_categories: data.expense_categories?.length
        ? data.expense_categories
        : DEFAULT_SETTINGS.expense_categories,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 1段目の承認が付いたあとの状態。
 * しきい値以上なら代表の承認待ちへ、未満ならそのまま承認済みへ。
 * しきい値 0 は「常に1段だけ」の意味にする。
 */
export function nextStatusFor(total, settings) {
  const th = Number(settings?.expense_owner_threshold ?? 0);
  return th > 0 && total >= th ? "pending_owner" : "approved";
}

/**
 * 明細の検証と整形。
 * @returns {{error:string, hint?:string}|{lines:object[]}}
 */
export function normalizeLines(input, settings) {
  if (!Array.isArray(input) || !input.length) {
    return { error: "no_lines", hint: "明細を1件以上入力してください" };
  }
  if (input.length > MAX_LINES) {
    return { error: "too_many_lines", hint: `明細は ${MAX_LINES} 件までです` };
  }

  const categories = settings?.expense_categories || DEFAULT_SETTINGS.expense_categories;
  const lines = [];

  for (const [i, raw] of input.entries()) {
    const n = i + 1;
    const amount = Number(raw?.amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
      return { error: "invalid_amount", hint: `${n} 行目の金額を確認してください（1円〜${MAX_AMOUNT.toLocaleString()}円）` };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw?.spentOn || "")) {
      return { error: "invalid_date", hint: `${n} 行目の日付を入れてください` };
    }
    const category = String(raw?.category ?? "").trim();
    if (!categories.includes(category)) {
      return { error: "invalid_category", hint: `${n} 行目の勘定科目を選び直してください` };
    }
    const taxRate = Number(raw?.taxRate ?? 10);
    if (!TAX_RATES.includes(taxRate)) {
      return { error: "invalid_tax_rate", hint: `${n} 行目の税率を確認してください` };
    }

    lines.push({
      spent_on: raw.spentOn,
      category,
      payee: raw.payee ? String(raw.payee).trim().slice(0, 120) : null,
      description: raw.description ? String(raw.description).trim().slice(0, 300) : null,
      amount,
      tax_rate: taxRate,
      invoice_registered: raw.invoiceRegistered !== false,
      receipt_path: raw.receiptPath ? String(raw.receiptPath) : null,
      receipt_name: raw.receiptName ? String(raw.receiptName).slice(0, 200) : null,
    });
  }
  return { lines };
}

export const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;

export const STATUS_LABEL = {
  pending: "承認待ち（管理部）",
  pending_owner: "承認待ち（代表）",
  approved: "承認済み",
  paid: "支払済み",
  rejected: "却下",
  cancelled: "取消",
};
