// GET  /api/guests/detail?id=…                     … 1人ぶん（右ドロワー用）
// POST /api/guests/detail { id, action, ... }
//        "reissue"      … 招待を再発行する（旧URLは無効になる。無効化も解除する）
//        "disable"      … 無効化する（招待取消／登録後のアクセス停止を1つの操作で行う）
//        "updateGrants" … 許可（プロジェクト・チャット・資料・タスク）を丸ごと入れ替える

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { normalizeGrant, guestStatus, RESOURCE_LABEL } from "../../lib/guests.js";
import { issueInvite } from "./index.js";

const SQL = "db/078_external_guests.sql";
const G_FIELDS = "id, tenant_id, display_name, company_name, email, user_id, "
  + "disabled_at, disabled_by, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return read(req, res, sb, ctx);
  if (req.method === "POST") return act(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function read(req, res, sb, ctx) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { data: guest, error } = await sb.from("gw_guests").select(G_FIELDS)
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  if (!guest) return json(res, 404, { error: "not_found" });

  const [{ data: invites }, { data: grants }] = await Promise.all([
    sb.from("gw_guest_invites")
      .select("id, expires_at, used_at, revoked_at, created_at")
      .eq("guest_id", id).order("created_at", { ascending: false }).limit(20),
    sb.from("gw_guest_grants")
      .select("id, resource_type, resource_key, resource_label, granted_at")
      .eq("guest_id", id).order("granted_at", { ascending: false }).limit(200),
  ]);

  return json(res, 200, {
    guest, status: guestStatus(guest, (invites || [])[0] || null),
    invites: invites || [],
    grants: (grants || []).map((g) => ({ ...g, typeLabel: RESOURCE_LABEL[g.resource_type] || g.resource_type })),
  });
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const { data: guest } = await sb.from("gw_guests").select(G_FIELDS)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!guest) return json(res, 404, { error: "not_found" });

  if (body.action === "reissue") return reissue(sb, ctx, user, guest, res);
  if (body.action === "disable") return disable(sb, ctx, user, guest, res);
  if (body.action === "updateGrants") return updateGrants(sb, ctx, user, guest, body, res);
  return json(res, 400, { error: "invalid_action" });
}

async function reissue(sb, ctx, user, guest, res) {
  // 未使用のまま残っている招待は、無効として履歴に残す（旧URLの無効化）
  await sb.from("gw_guest_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("guest_id", guest.id).is("used_at", null).is("revoked_at", null);

  const invite = await issueInvite(sb, ctx, user, guest.id);
  if (invite.error) return json(res, 500, { error: "invite_failed", detail: invite.error });

  if (guest.disabled_at) {
    await sb.from("gw_guests")
      .update({ disabled_at: null, disabled_by: null, updated_at: new Date().toISOString() })
      .eq("id", guest.id);
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "guest.reissue",
    target: `guest:${guest.id}`, detail: { name: guest.display_name, expiresAt: invite.expiresAt },
  });
  return json(res, 200, { token: invite.token, expiresAt: invite.expiresAt });
}

async function disable(sb, ctx, user, guest, res) {
  const now = new Date().toISOString();
  const { error } = await sb.from("gw_guests")
    .update({ disabled_at: now, disabled_by: user.id, updated_at: now })
    .eq("id", guest.id);
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });

  await sb.from("gw_guest_invites")
    .update({ revoked_at: now })
    .eq("guest_id", guest.id).is("used_at", null).is("revoked_at", null);

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "guest.disable",
    target: `guest:${guest.id}`, detail: { name: guest.display_name },
  });
  return json(res, 200, { ok: true });
}

async function updateGrants(sb, ctx, user, guest, body, res) {
  const list = Array.isArray(body.grants) ? body.grants : [];
  const rows = [];
  for (const g of list) {
    const gr = normalizeGrant(g);
    if (gr.error) return json(res, 400, gr);
    rows.push({ ...gr.value, tenant_id: ctx.tenantId, guest_id: guest.id, granted_by: user.id });
  }

  const { error: de } = await sb.from("gw_guest_grants").delete().eq("guest_id", guest.id);
  if (de) return json(res, error500(de), { error: "db_delete_failed", detail: de.message });
  if (rows.length) {
    const { error: ie } = await sb.from("gw_guest_grants").insert(rows);
    if (ie) return json(res, error500(ie), { error: "db_insert_failed", detail: ie.message });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "guest.grant_change",
    target: `guest:${guest.id}`, detail: { name: guest.display_name, count: rows.length },
  });
  return json(res, 200, { ok: true, count: rows.length });
}

const error500 = (e) => (e.code === "42501" ? 403 : 500);
