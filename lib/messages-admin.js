// メンバー → 管理サイド共通チャット（db/079）の下ごしらえ。
//
// 「共通受信箱」は、参加者を固定で決め打ちしない。本人 + そのときの
// 管理サイド（gw_is_hr と同じ判定）を、必要になるたびに gw_thread_members へ
// 足していく。参加者の追加は010の方針どおりRLSでは許可しないので、
// ここは常に service_role（admin()）で呼ぶこと。

// 「管理サイド」とみなす社員IDの一覧。
// DB側の gw_is_hr(tenant) / API層の canManageHr(ctx) と同じ判定基準
// （hr・owner ロール、または memberships が admin/staff）に合わせている。
export async function adminSideEmployeeIds(sb, tenantId) {
  const [{ data: staffM }, { data: employees }] = await Promise.all([
    sb.from("memberships").select("user_id").eq("tenant_id", tenantId).in("role", ["admin", "staff"]),
    sb.from("gw_employees").select("id, user_id").eq("tenant_id", tenantId).neq("status", "left"),
  ]);

  const staffUserIds = new Set((staffM || []).map((m) => m.user_id));
  const ids = new Set();
  const empIds = [];
  for (const e of employees || []) {
    empIds.push(e.id);
    if (e.user_id && staffUserIds.has(e.user_id)) ids.add(e.id);
  }

  if (empIds.length) {
    const { data: grants } = await sb.from("gw_role_grants")
      .select("employee_id").in("employee_id", empIds).in("role", ["hr", "owner"]);
    for (const g of grants || []) ids.add(g.employee_id);
  }
  return [...ids];
}

// 本人の窓口を探す（無ければ null）
export async function findAdminContactThread(sb, tenantId, contactEmployeeId) {
  const { data } = await sb.from("gw_threads")
    .select("id").eq("tenant_id", tenantId).eq("kind", "admin_contact")
    .eq("contact_employee_id", contactEmployeeId).limit(1).maybeSingle();
  return data?.id || null;
}

// 開設する。既にあれば作り直さず、いまの管理サイドで参加者を揃えてから返す
export async function openAdminContactThread(sb, tenantId, contactEmployee, createdByUserId) {
  const existing = await findAdminContactThread(sb, tenantId, contactEmployee.id);
  if (existing) {
    await syncAdminContactMembers(sb, tenantId, existing, contactEmployee.id);
    return { threadId: existing, existed: true };
  }

  const { data: thread, error } = await sb.from("gw_threads")
    .insert({
      tenant_id: tenantId, kind: "admin_contact",
      contact_employee_id: contactEmployee.id, created_by: createdByUserId,
    })
    .select("id").single();
  if (error) throw error;

  await syncAdminContactMembers(sb, tenantId, thread.id, contactEmployee.id);
  return { threadId: thread.id, existed: false };
}

// このスレッドの参加者を、いまの管理サイドの顔ぶれ + 本人に合わせる。
// 足りない人を足すだけで、外れた人は自動では外さない
// （抜けたら過去も読めなくなる、という010の仕様に合わせている。外すのは運用で）
export async function syncAdminContactMembers(sb, tenantId, threadId, contactEmployeeId) {
  const staffIds = await adminSideEmployeeIds(sb, tenantId);
  const wanted = new Set([...staffIds, contactEmployeeId]);

  const { data: existing } = await sb.from("gw_thread_members")
    .select("employee_id").eq("thread_id", threadId);
  const already = new Set((existing || []).map((m) => m.employee_id));

  const toAdd = [...wanted].filter((id) => !already.has(id));
  if (!toAdd.length) return;

  await sb.from("gw_thread_members").insert(toAdd.map((employee_id) => ({
    tenant_id: tenantId, thread_id: threadId, employee_id, role: "member",
  })));
}

// admin_contact スレッドの表示名。本人には固定文言、管理サイドの人には
// 「誰からの連絡か」が分かる名前を出す。dm/group では null（呼び出し側の
// 通常ロジックにフォールバックさせる）
export function adminContactDisplayName(thread, ctx, members) {
  if (thread.kind !== "admin_contact") return null;
  if (thread.contact_employee_id === ctx.employee.id) return "管理サイドへの連絡";
  const contact = (members || []).find((m) => m.id === thread.contact_employee_id);
  return contact ? `${contact.display_name} さんからの連絡` : "管理サイドへの連絡";
}

// いま管理サイドの人（ctx.employee）を、このテナントの admin_contact
// スレッド「全部」に参加させておく。メッセージ一覧を開くたびに呼ぶことで、
// 新しく管理側になった人も、次に開いた時点で過去のやりとりごと見える
export async function ensureAdminContactInbox(sb, tenantId, employeeId) {
  const { data: threads } = await sb.from("gw_threads")
    .select("id").eq("tenant_id", tenantId).eq("kind", "admin_contact");
  const ids = (threads || []).map((t) => t.id);
  if (!ids.length) return;

  const { data: mine } = await sb.from("gw_thread_members")
    .select("thread_id").eq("employee_id", employeeId).in("thread_id", ids);
  const already = new Set((mine || []).map((m) => m.thread_id));
  const missing = ids.filter((id) => !already.has(id));
  if (!missing.length) return;

  await sb.from("gw_thread_members").insert(missing.map((thread_id) => ({
    tenant_id: tenantId, thread_id, employee_id: employeeId, role: "member",
  })));
}
