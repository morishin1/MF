// GET  /api/guests                … 外部メンバー一覧（管理者・人事）
// POST /api/guests {displayName, companyName, email, grants?} … 招待する
//
// 作成すると、その場で最初の招待（gw_guest_invites）も1件作る。
// 平文のトークンは、この応答に1度だけ入れて返す。DBには sha256 のハッシュだけ

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  normalizeGuest, normalizeGrant, guestStatus,
  sha256, newInviteToken, INVITE_TTL_HOURS,
} from "../../lib/guests.js";

const SQL = "db/078_external_guests.sql";
const G_FIELDS = "id, tenant_id, display_name, company_name, email, user_id, "
  + "disabled_at, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 外部メンバーの氏名・会社・招待範囲を返す。社外の人の情報なので二段階認証の対象と同じ扱い
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return create(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function list(req, res, sb, ctx) {
  const { data: guests, error } = await sb.from("gw_guests").select(G_FIELDS)
    .eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { guests: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  if (!guests?.length) return json(res, 200, { guests: [] });

  const ids = guests.map((g) => g.id);
  const [{ data: invites }, { data: grants }] = await Promise.all([
    sb.from("gw_guest_invites")
      .select("id, guest_id, expires_at, used_at, revoked_at, created_at")
      .in("guest_id", ids).order("created_at", { ascending: false }).limit(2000),
    sb.from("gw_guest_grants").select("guest_id, resource_type, resource_label, resource_key")
      .in("guest_id", ids).limit(4000),
  ]);

  const latestInvite = new Map();
  for (const inv of invites || []) if (!latestInvite.has(inv.guest_id)) latestInvite.set(inv.guest_id, inv);
  const grantsByGuest = new Map();
  for (const g of grants || []) {
    if (!grantsByGuest.has(g.guest_id)) grantsByGuest.set(g.guest_id, []);
    grantsByGuest.get(g.guest_id).push(g);
  }

  // 最終ログインは auth.users にしかない。登録済みのぶんだけ、まとめて引く
  const userIds = guests.map((g) => g.user_id).filter(Boolean);
  const lastLogin = await lastLoginMap(userIds);

  const rows = guests.map((g) => {
    const inv = latestInvite.get(g.id) || null;
    const gs = grantsByGuest.get(g.id) || [];
    return {
      id: g.id, displayName: g.display_name, companyName: g.company_name, email: g.email,
      status: guestStatus(g, inv),
      grants: gs.map((x) => ({ type: x.resource_type, key: x.resource_key, label: x.resource_label })),
      invitedAt: g.created_at,
      expiresAt: inv?.expires_at || null,
      lastLoginAt: g.user_id ? (lastLogin.get(g.user_id) || null) : null,
    };
  });
  return json(res, 200, { guests: rows });
}

async function lastLoginMap(userIds) {
  const map = new Map();
  const uniq = [...new Set(userIds)];
  if (!uniq.length) return map;
  const sbAdmin = admin();
  await Promise.all(uniq.map(async (uid) => {
    try {
      const { data } = await sbAdmin.auth.admin.getUserById(uid);
      if (data?.user?.last_sign_in_at) map.set(uid, data.user.last_sign_in_at);
    } catch { /* 取れなくても一覧は出す */ }
  }));
  return map;
}

async function create(req, res, sb, ctx, user) {
  const body = await readJson(req);
  const row = normalizeGuest(body);
  if (row.error) return json(res, 400, row);

  const { data: guest, error } = await sb.from("gw_guests")
    .insert({ ...row.value, tenant_id: ctx.tenantId, created_by: user.id })
    .select(G_FIELDS).single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  // 許可（任意。あとから足すこともできる）
  const grants = Array.isArray(body?.grants) ? body.grants : [];
  const grantRows = [];
  for (const g of grants) {
    const gr = normalizeGrant(g);
    if (gr.error) continue; // 個々の不正は無視して、招待自体は成立させる
    grantRows.push({ ...gr.value, tenant_id: ctx.tenantId, guest_id: guest.id, granted_by: user.id });
  }
  if (grantRows.length) {
    const { error: ge } = await sb.from("gw_guest_grants").insert(grantRows);
    if (ge) console.error("[guests] 許可の登録に失敗:", ge.message);
  }

  const invite = await issueInvite(sb, ctx, user, guest.id);
  if (invite.error) return json(res, 500, { error: "invite_failed", detail: invite.error });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "guest.invite",
    target: `guest:${guest.id}`,
    detail: { name: guest.display_name, email: guest.email, grants: grantRows.length },
  });

  return json(res, 200, { guest, token: invite.token, expiresAt: invite.expiresAt });
}

/** 招待を1件発行する。作成にも「招待を再発行」にも使う共通処理 */
export async function issueInvite(sb, ctx, user, guestId) {
  const token = newInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600000).toISOString();
  const { error } = await sb.from("gw_guest_invites").insert({
    tenant_id: ctx.tenantId, guest_id: guestId, token_hash: sha256(token),
    expires_at: expiresAt, created_by: user.id,
  });
  if (error) return { error: error.message };
  return { token, expiresAt };
}
