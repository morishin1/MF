// POST /api/employees/link  { employeeId, email, clientId?, create?, password? }
// 社員名簿の行を、ログインアカウント（auth.users）に紐づける。
//
// 名簿に先に登録した内定者を、ログインアカウントに結び付ける。
// create:true を渡すと、アカウントが無い場合はここで作る（招待）。
// password を省略すると自動生成し、その1回だけ応答に含めて画面に出す。
// メール送信の設定に依存させないため、本人へは管理者が直接伝える方式。
// 紐づけただけでは何も使えないため、そのテナントのメンバーシップが無ければ
// 併せて作る（会計側は顧問先ロール＝書類のアップロードのみ）。
//
// 人事権限が必要。auth.users の検索と memberships の作成は service_role で行う。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.isHr) return json(res, 403, { error: "forbidden", hint: "紐づけには人事権限が必要です" });

  const body = await readJson(req);
  const { employeeId } = body || {};
  const email = String(body?.email || "").trim().toLowerCase();
  if (!employeeId || !email) return json(res, 400, { error: "invalid_body", required: ["employeeId", "email"] });

  const sb = admin();

  const { data: employee, error: ee } = await sb
    .from("gw_employees")
    .select("id, display_name, user_id")
    .eq("id", employeeId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (ee) return json(res, 500, { error: "db_query_failed", detail: ee.message });
  if (!employee) return json(res, 404, { error: "employee_not_found" });
  if (employee.user_id) return json(res, 409, { error: "already_linked" });

  let userId = await findUserByEmail(sb, email);
  let createdPassword = null;

  if (!userId) {
    // 招待: アカウントが無ければここで作る。Supabase の管理画面を開かずに済む。
    // メール送信の設定に依存させたくないので、初回パスワードは画面に出して
    // 本人へ直接渡してもらう方式にする。
    if (!body?.create) {
      return json(res, 404, {
        error: "auth_user_not_found",
        hint: "そのメールアドレスのログインアカウントがありません。「アカウントを作る」を押すとこの場で作成できます",
      });
    }
    const password = String(body.password || "").trim() || randomPassword();
    if (password.length < 8) {
      return json(res, 400, { error: "weak_password", hint: "パスワードは8文字以上にしてください" });
    }
    const { data: created, error: ce } = await sb.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (ce) return json(res, 500, { error: "create_user_failed", detail: ce.message });
    userId = created.user.id;
    createdPassword = body.password ? null : password;   // 自動生成のときだけ返す
  }

  // 1つのアカウントを2人の社員に割り当てない
  const { data: taken } = await sb
    .from("gw_employees")
    .select("id, display_name")
    .eq("tenant_id", ctx.tenantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (taken) {
    return json(res, 409, { error: "user_already_assigned", detail: `${taken.display_name} さんに割り当て済みです` });
  }

  const { error: ue } = await sb
    .from("gw_employees")
    .update({ user_id: userId, updated_at: new Date().toISOString() })
    .eq("id", employeeId);
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  // 社労士は社外の人なので、会計側の権限は一切与えない。
  // 名簿の行だけで手続き画面に入れる（lib/gw.js がテナントを名簿から解決する）。
  const { data: grants } = await sb
    .from("gw_role_grants")
    .select("role")
    .eq("employee_id", employeeId);
  const isAdvisor = (grants || []).some((g) => g.role === "labor_advisor");
  if (isAdvisor) {
    return json(res, 200, {
      ok: true, employeeId, userId, createdPassword,
      membership: { created: false, role: null, note: "社労士のため会計の権限は付与していません" },
    });
  }

  // 会計側のメンバーシップ。既にあれば触らない（管理者を降格させないため）
  const membership = await ensureMembership(sb, ctx.tenantId, userId, body?.clientId);

  return json(res, 200, { ok: true, employeeId, userId, createdPassword, membership });
}

// 初回パスワード。読み上げや転記で困らないよう、紛らわしい文字を外す
function randomPassword(len = 12) {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function findUserByEmail(sb, email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("listUsers: " + error.message);
    const hit = (data?.users || []).find((u) => (u.email || "").toLowerCase() === email);
    if (hit) return hit.id;
    if (!data?.users?.length || data.users.length < 200) break;
  }
  return null;
}

async function ensureMembership(sb, tenantId, userId, clientId) {
  const { data: existing } = await sb
    .from("memberships")
    .select("id, role")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (existing) return { created: false, role: existing.role };

  let targetClient = clientId;
  if (!targetClient) {
    const { data: client } = await sb
      .from("clients")
      .select("id")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true })
      .limit(1)
      .maybeSingle();
    targetClient = client?.id || null;
  }
  if (!targetClient) return { created: false, role: null, note: "取引先が未登録のためメンバーシップは作りませんでした" };

  const { error } = await sb
    .from("memberships")
    .insert({ tenant_id: tenantId, user_id: userId, role: "client", client_id: targetClient });
  if (error) return { created: false, role: null, note: error.message };
  return { created: true, role: "client" };
}
