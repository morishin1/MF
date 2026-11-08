// 企業ポータル・商談準備の DB 操作（Sales の API から使う）。決まりごとは lib/sales-company-portal.js。
// すべて service_role（admin()）で読み書きする。呼ぶ前に、API 側で Sales の権限とテナントを確かめること。

import { PORTAL_TABLES as T, isMissingTable } from "./sales-company-portal.js";
import { PUBLIC_TALENT_COLUMNS_BASE, PUBLIC_TALENT_COLUMNS_EXT, EXT_LABELS } from "./enger-talent-public.js";

const likeExact = (s) => String(s).replace(/[\\%_]/g, (c) => "\\" + c);

/**
 * その企業IDが、このテナントの Sales の企業一覧に入っているか（Sales の企業詳細と同じ範囲）。
 * @returns {Promise<{ok:true, company:{id,name}}|{ok:false, status:number, error:string}>}
 */
export async function companyInScope(db, tenantId, companyId) {
  const r = await db.schema("enger").from("dx2_sales_company_directory_for_tenant")
    .select("id,name").eq("tenant_id", tenantId).eq("id", companyId).maybeSingle();
  if (r.error) return { ok: false, status: 503, error: "company_unavailable" };
  if (!r.data) return { ok: false, status: 404, error: "company_not_found" };
  return { ok: true, company: { id: r.data.id, name: r.data.name } };
}

/** 記録（追記だけ）。失敗しても本処理は止めない（結果を返して画面に出す） */
export async function logPortalEvent(db, e) {
  try {
    const r = await db.schema("enger").from(T.events).insert({
      company_id: e.companyId ?? null,
      member_id: e.memberId ?? null,
      actor_kind: e.actorKind,
      actor_user_id: e.actorUserId ?? null,
      action: e.action,
      target_id: e.targetId == null ? null : String(e.targetId).slice(0, 100),
      detail: e.detail && typeof e.detail === "object" ? e.detail : {},
    });
    return !r.error;
  } catch {
    return false;
  }
}

/**
 * 社内の人のメールか（社員名簿・ENGER の社内メンバー）。
 * 社内のアカウントを企業ポータルの利用者にしない（社内と社外の認証・権限を混ぜない）。
 * @returns {Promise<boolean|null>} 確かめられないときは null
 */
export async function isInternalEmail(db, email) {
  const pattern = likeExact(email);
  const [emp, staff] = await Promise.all([
    db.from("gw_employees").select("id").ilike("email", pattern).limit(1),
    db.schema("enger").from("app_users").select("id,role,status").ilike("email", pattern).limit(5),
  ]);
  if (emp.error && !isMissingTable(emp.error)) return null;
  if (staff.error && !isMissingTable(staff.error)) return null;
  if ((emp.data || []).length) return true;
  return (staff.data || []).some((u) => ["admin", "agent"].includes(u.role));
}

/**
 * 停止・再開のとき、Auth のアカウント自体も止める・戻す（停止中は新しいセッションを作れない・更新できない）。
 * 企業ポータル専用のアカウント（app_metadata.apps が business だけ・社員名簿に無い）に限る。
 * フリーランス・右腕COO などと兼ねているアカウントは止めない（ほかのサービスまで止めてしまうため）。
 * その場合も、企業ポータル側は利用者の停止（disabled_at）で検索・保存・ログインを拒否する。
 */
export async function setPortalAuthBan(db, authUserId, banned) {
  if (!authUserId) return { applied: false, reason: "not_registered" };
  try {
    const got = await db.auth.admin.getUserById(authUserId);
    const user = got?.data?.user;
    if (got?.error || !user) return { applied: false, reason: "lookup_failed" };
    const apps = user.app_metadata?.apps;
    const portalOnly = Array.isArray(apps) && apps.length > 0 && apps.every((a) => a === "business");
    if (!portalOnly) return { applied: false, reason: "shared_account" };
    const emp = await db.from("gw_employees").select("id").eq("user_id", authUserId).limit(1);
    if (emp.error && !isMissingTable(emp.error)) return { applied: false, reason: "lookup_failed" };
    if ((emp.data || []).length) return { applied: false, reason: "internal_account" };
    const r = await db.auth.admin.updateUserById(authUserId, { ban_duration: banned ? "876000h" : "none" });
    return r?.error ? { applied: false, reason: "update_failed" } : { applied: true };
  } catch {
    return { applied: false, reason: "lookup_failed" };
  }
}

/** 利用者ごとの最新の招待 */
export async function latestInvites(db, memberIds) {
  if (!memberIds.length) return { map: new Map() };
  const r = await db.schema("enger").from(T.invites)
    .select("id,member_id,created_at,expires_at,used_at,revoked_at")
    .in("member_id", memberIds).order("created_at", { ascending: false }).limit(500);
  if (r.error) return { error: r.error };
  const map = new Map();
  for (const inv of r.data || []) if (!map.has(inv.member_id)) map.set(inv.member_id, inv);
  return { map };
}

/**
 * 人材を許可された列だけで読む。列が足りない環境では狭い列で読み直し、落とした項目を返す。
 * @param {(q:any, ext:boolean)=>any} build  絞り込みを足す関数（select の後に呼ばれる）。null を返すと0件
 */
export async function readPublicCandidates(db, build, limit) {
  const run = async (cols, strict, ext) => {
    let q = db.schema("enger").from("candidates").select(cols).is("deleted_at", null);
    if (strict) q = q.eq("is_closed", false);
    q = build(q, ext);
    if (!q) return { data: [] };
    return q.order("created_at", { ascending: false, nullsFirst: false }).limit(limit);
  };
  let missing = [];
  let ext = true;
  let r = await run(PUBLIC_TALENT_COLUMNS_EXT, true, true);
  if (r.error) { ext = false; missing = EXT_LABELS; r = await run(PUBLIC_TALENT_COLUMNS_BASE, true, false); }
  if (r.error) r = await run(PUBLIC_TALENT_COLUMNS_BASE, false, false);
  if (r.error) return { error: r.error };
  return { rows: r.data || [], missing, ext };
}
