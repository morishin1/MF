// GET    /api/partners          … BP企業（パートナー企業）の一覧
// POST   /api/partners          … 追加
// PATCH  /api/partners {id,...} … 更新
// DELETE /api/partners?id=…     … 削除（そこに属するBP要員が1人でもいれば止める）
//
// 可視範囲・書き込み可否は RLS（db/075_partner_bp.sql）が決める。
// ここでの分岐は入口の親切表示のため。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const SQL = "db/075_partner_bp.sql";
const FIELDS = "id, tenant_id, company_name, invoice_registration_number, "
  + "billing_contact_name, billing_contact_email, note, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 請求先・インボイス登録番号など、社外に出せない情報を返す。名簿と同じ扱い
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return create(req, res, sb, ctx, user);
  if (req.method === "PATCH") return update(req, res, sb, ctx, user);
  if (req.method === "DELETE") return remove(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

async function list(req, res, sb, ctx) {
  const { data, error } = await sb.from("gw_partner_companies").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).order("company_name", { ascending: true }).limit(500);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { companies: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  return json(res, 200, { companies: data || [], canManage: canManageHr(ctx) });
}

async function create(req, res, sb, ctx, user) {
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
  const body = await readJson(req);
  const row = normalize(body);
  if (row.error) return json(res, 400, row);

  const { data, error } = await sb.from("gw_partner_companies")
    .insert({ ...row.value, tenant_id: ctx.tenantId }).select(FIELDS).single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "partner.create",
    target: `partner:${data.id}`, detail: { name: data.company_name },
  });
  return json(res, 200, { company: data });
}

async function update(req, res, sb, ctx, user) {
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const row = normalize(body, { partial: true });
  if (row.error) return json(res, 400, row);

  const { data, error } = await sb.from("gw_partner_companies")
    .update({ ...row.value, updated_at: new Date().toISOString() })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select(FIELDS).maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "partner.update",
    target: `partner:${data.id}`, detail: { name: data.company_name },
  });
  return json(res, 200, { company: data });
}

async function remove(req, res, sb, ctx, user) {
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { data: target } = await sb.from("gw_partner_companies").select("id, company_name")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!target) return json(res, 404, { error: "not_found" });

  // 何人属しているかを、DBの制約（on delete restrict）に投げる前に伝える。
  // 制約だけに任せると、ただの db_delete_failed になって理由が分からない
  const { count } = await sb.from("gw_employees").select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenantId).eq("partner_company_id", id);
  if (count) {
    return json(res, 409, {
      error: "partner_has_members",
      hint: `${target.company_name} には、まだ${count}名のBP要員がいます。` +
            "先に名簿側で所属先を変えるか、退職にしてください。",
    });
  }

  const { error } = await sb.from("gw_partner_companies").delete()
    .eq("id", id).eq("tenant_id", ctx.tenantId);
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "partner.delete",
    target: `partner:${id}`, detail: { name: target.company_name },
  });
  return json(res, 200, { ok: true, id });
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;
  const str = (s, max) => { const t = String(s ?? "").trim(); return t ? t.slice(0, max) : null; };

  if (!partial || has("company_name")) {
    const name = str(body.company_name, 200);
    if (!name) return { error: "invalid_body", detail: "company_name は必須です" };
    v.company_name = name;
  }
  if (has("invoice_registration_number")) v.invoice_registration_number = str(body.invoice_registration_number, 20);
  if (has("billing_contact_name")) v.billing_contact_name = str(body.billing_contact_name, 100);
  if (has("billing_contact_email")) v.billing_contact_email = str(body.billing_contact_email, 200);
  if (has("note")) v.note = str(body.note, 1000);
  return { value: v };
}
