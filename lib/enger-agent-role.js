// ENGER営業エージェントの「役割」を、部署名ではなく実際の認可データで判定する。
//
// ■ 役割の正本（GW側で読み書きするもの）
//   enger.organization_memberships … user_id = 本人の Supabase Auth user_id（GWと同じ1つのログイン）
//     membership_type='external', role='member', organization_id/partner_organization_id = null
//   enger.member_product_access     … product='partner_sales' の行がある ＝ 役割を付与済み
//     can_view=true になって初めて企業を閲覧できる（初期値は全部 false）
//   enger.member_data_scope         … scope_type='company' ＝ 担当企業（テナント内のみ）
//
// ■ 以前の判定（PR #363）との違い
//   gw_employees.department='ENGERエージェント' を役割の識別子にしていた。部署を変えると
//   役割が消えたように見え、退職時の権限停止も効かなくなる。ここでは使わない
//   （LEGACY_AGENT_DEPARTMENT は一覧で「旧方式で登録された人」を拾うためだけに残す）。
//
// ■ 安全側に倒す
//   ・社内メンバー（internal）や他組織の所属を external に変換しない。
//   ・ENGER社内メンバー（enger.app_users の admin/agent）に外部所属を足さない。
//     DX は app_users.id → 見つからなければ Auth の user_id の順で所属を引くため、
//     未移行の社内メンバーに external を作ると DX の権限を意図せず狭める。
//   ・停止は「閲覧OFF → 担当企業削除 → 所属を inactive」の順。途中で失敗したら例外にして、
//     呼び出し側は処理を止める（権限が残ったまま名簿だけ退職にしない）。

export const AGENT_PRODUCT = "partner_sales";
export const LEGACY_AGENT_DEPARTMENT = "ENGERエージェント";
export const MEMBERSHIP_COLUMNS = "id,user_id,membership_type,role,status,organization_id,partner_organization_id";
export const CLOSED_ACCESS = Object.freeze({
  can_view: false, can_create: false, can_edit: false,
  can_approve: false, can_export: false, can_manage: false,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERNAL_ENGER_ROLES = new Set(["admin", "agent"]);

/** GWが管理してよい（＝GWが作った形の）外部エージェント所属か */
export function isAgentMembership(m) {
  return Boolean(m) && m.membership_type === "external" && m.role === "member" &&
    !m.organization_id && !m.partner_organization_id;
}

/** 1人の所属（user_id 一意の前提。2件以上は曖昧なので止める） */
export async function membershipFor(sb, userId) {
  if (!UUID.test(userId || "")) return null;
  const r = await sb.schema("enger").from("organization_memberships")
    .select(MEMBERSHIP_COLUMNS).eq("user_id", userId).limit(2);
  if (r.error) throw r.error;
  if ((r.data || []).length > 1) throw new Error("ambiguous_membership");
  return r.data?.[0] || null;
}

/**
 * 複数人の役割の状態を1回ずつの読み取りで返す。
 * @returns {Promise<Map<string,{membership:object,access:object|null,companyIds:string[],role:boolean,conflict:boolean}>>}
 *   キーは Auth user_id。所属の無い人は入らない。
 */
export async function loadAgentRoles(sb, userIds) {
  const ids = [...new Set((userIds || []).filter((x) => UUID.test(x || "")))];
  const out = new Map();
  if (!ids.length) return out;
  const m = await sb.schema("enger").from("organization_memberships")
    .select(MEMBERSHIP_COLUMNS).in("user_id", ids).limit(ids.length * 2);
  if (m.error) throw m.error;
  const rows = m.data || [];
  const mids = rows.map((x) => x.id).filter(Boolean);
  let access = [], scopes = [];
  if (mids.length) {
    const [a, s] = await Promise.all([
      sb.schema("enger").from("member_product_access")
        .select("membership_id,product,can_view").in("membership_id", mids).eq("product", AGENT_PRODUCT),
      sb.schema("enger").from("member_data_scope")
        .select("membership_id,scope_type,scope_id").in("membership_id", mids).eq("scope_type", "company"),
    ]);
    if (a.error || s.error) throw a.error || s.error;
    access = a.data || []; scopes = s.data || [];
  }
  for (const row of rows) {
    if (out.has(row.user_id)) { out.get(row.user_id).conflict = true; continue; }
    const grant = access.find((x) => x.membership_id === row.id) || null;
    out.set(row.user_id, {
      membership: row,
      access: grant,
      companyIds: scopes.filter((x) => x.membership_id === row.id).map((x) => x.scope_id),
      // 役割＝GW形式の外部所属 ＋ partner_sales の行がある
      role: isAgentMembership(row) && Boolean(grant),
      conflict: !isAgentMembership(row),
    });
  }
  return out;
}

/**
 * ENGERの社内メンバー（DXに入れる admin/agent）か。メールで突合する（DXの requireWriter と同じ）。
 * 読めなかったら例外（＝付与しない側に倒す）。
 */
export async function isEngerInternalUser(sb, email) {
  const e = String(email || "").trim();
  if (!e) return false;
  const r = await sb.schema("enger").from("app_users")
    .select("id,role,status").ilike("email", e.replace(/[\\%_]/g, "\\$&")).limit(5);
  if (r.error) throw r.error;
  return (r.data || []).some((u) => INTERNAL_ENGER_ROLES.has(String(u.role || "").trim().toLowerCase()));
}

/**
 * エージェントの閲覧権限を閉じる（退職・停止・削除前）。
 * GW形式の外部所属でない人（社内メンバー等）には何もしない。
 * @returns {Promise<{revoked:boolean}>}
 */
export async function revokeAgentAccess(sb, userId) {
  const member = await membershipFor(sb, userId);
  if (!isAgentMembership(member)) return { revoked: false };
  const closed = await sb.schema("enger").from("member_product_access")
    .update({ ...CLOSED_ACCESS }).eq("membership_id", member.id).eq("product", AGENT_PRODUCT);
  if (closed.error) throw closed.error;
  const scopes = await sb.schema("enger").from("member_data_scope")
    .delete().eq("membership_id", member.id).eq("scope_type", "company");
  if (scopes.error) throw scopes.error;
  const status = await sb.schema("enger").from("organization_memberships")
    .update({ status: "inactive" }).eq("id", member.id).eq("user_id", userId);
  if (status.error) throw status.error;
  return { revoked: true };
}
