// POST /api/employees/bulk { rows: [...], createAccounts?: boolean }
//
// 名簿にまとめて追加する。1人ずつフォームを埋めるのが現実的でないため
// （入社が重なる月は10人を超える）、表計算からそのまま貼れる形にした。
//
// 1行ずつ処理して、失敗した行だけを理由つきで返す。
// 途中で止めない理由: 20行のうち3行目でメールが重複していたときに
// 全部やり直しになると、結局手作業のほうが速くなってしまう。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { attachAccount } from "../../lib/accounts.js";

const EMPLOYMENT_TYPES = ["正社員", "契約社員", "パート", "アルバイト", "業務委託", "役員", "その他"];
const MAX_ROWS = 200;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const body = await readJson(req);
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows?.length) return json(res, 400, { error: "invalid_body", required: ["rows"] });
  if (rows.length > MAX_ROWS) {
    return json(res, 400, { error: "too_many_rows", hint: `一度に取り込めるのは ${MAX_ROWS} 行までです` });
  }
  // アカウントまで作るかどうか。人事権限が無い人は名簿への追加だけ
  const withAccounts = body.createAccounts !== false && canManageHr(ctx);

  const sb = admin();

  // 同じ名前が既にいる場合は足さない。取り込みを2回押しても増えないようにする
  const { data: existing } = await sb
    .from("gw_employees").select("display_name, email")
    .eq("tenant_id", ctx.tenantId).limit(1000);
  const names = new Set((existing || []).map((e) => e.display_name));
  const mails = new Set((existing || []).map((e) => (e.email || "").toLowerCase()).filter(Boolean));

  const added = [];
  const skipped = [];
  const failed = [];

  for (const [i, raw] of rows.entries()) {
    const line = i + 1;
    const name = String(raw?.display_name ?? "").trim();
    if (!name) { failed.push({ line, name: "", reason: "氏名が空です" }); continue; }
    if (names.has(name)) { skipped.push({ line, name, reason: "同じ氏名の人が既にいます" }); continue; }

    const email = String(raw?.email ?? "").trim().toLowerCase() || null;
    if (email && mails.has(email)) { skipped.push({ line, name, reason: "同じメールの人が既にいます" }); continue; }

    const type = String(raw?.employment_type ?? "").trim();
    if (type && !EMPLOYMENT_TYPES.includes(type)) {
      failed.push({ line, name, reason: `雇用区分「${type}」は使えません（${EMPLOYMENT_TYPES.join("・")}）` });
      continue;
    }

    const joined = String(raw?.joined_on ?? "").trim();
    if (joined && !/^\d{4}-\d{2}-\d{2}$/.test(joined)) {
      failed.push({ line, name, reason: "入社日は 2026-04-01 の形で入れてください" });
      continue;
    }

    const { data: emp, error } = await sb.from("gw_employees").insert({
      tenant_id: ctx.tenantId,
      display_name: name,
      email,
      department: String(raw?.department ?? "").trim() || null,
      position: String(raw?.position ?? "").trim() || null,
      employment_type: type || null,
      joined_on: joined || null,
      status: "invited",
    }).select("id, display_name, user_id, employment_type").single();

    if (error) { failed.push({ line, name, reason: error.message }); continue; }

    names.add(name);
    if (email) mails.add(email);

    const entry = { line, name, id: emp.id };
    if (withAccounts && email) {
      const r = await attachAccount(sb, { tenantId: ctx.tenantId, employee: emp, email });
      if (r.ok) {
        entry.email = email;
        // 自動生成した初回パスワードは、この応答でしか出せない。
        // 保存すると平文で残るので、画面に出して管理者に渡してもらう
        entry.password = r.createdPassword;
        entry.systems = r.systems;
      } else {
        entry.accountError = r.hint || r.detail || r.error;
      }
    }
    added.push(entry);
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "employee.bulk_create",
    target: `tenant:${ctx.tenantId}`,
    detail: { added: added.length, skipped: skipped.length, failed: failed.length },
  });

  return json(res, 200, { added, skipped, failed, withAccounts });
}
