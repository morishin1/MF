// POST /api/admin/setup
// 実データ版の初期ブートストラップ（1回だけ実行する想定）。
//   - documents ストレージバケット（非公開）を作成
//   - 事務所(tenant) / 顧問先(client) を作成
//   - アカウントごとに Auth ユーザー / メンバーシップ / 社員名簿(gw_employees) を作成
//
// セキュリティ:
//   - 環境変数 SETUP_SECRET が未設定なら無効（503）。
//   - リクエストヘッダ x-setup-secret が SETUP_SECRET と一致しない限り拒否（401）。
//   - service_role を使うため RLS をバイパスする。使用後は SETUP_SECRET を外す/エンドポイントを消す運用推奨。
//
// 入力:
//   {
//     email, password?,            // 主アカウント（role は staff 固定）
//     displayName?, gwRoles?,      // 主アカウントの社員名簿の表示名・社内ロール
//     tenantName, clientName, industry?, fiscalMonth?,
//     accounts?: [                 // 追加アカウント（デモ用のメンバーなど）
//       { email, password?, role?, displayName?, gwRoles? }
//     ]
//   }
//   role     … 'admin' | 'staff' | 'client'（既定 'client'）。'client' は clientName の取引先に紐づく。
//   gwRoles  … 'owner' | 'hr' | 'manager' | 'labor_advisor' の配列（既定なし＝一般社員）
//
// 出力: { ok, tenantId, clientId, bucket, accounts: [...], created:{...} }

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";

const MEMBERSHIP_ROLES = ["admin", "staff", "client"];
const GW_ROLES = ["owner", "hr", "manager", "labor_advisor"];

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const secret = process.env.SETUP_SECRET;
  if (!secret) return json(res, 503, { error: "setup_disabled", hint: "SETUP_SECRET を Vercel 環境変数に設定してください" });
  const given = req.headers["x-setup-secret"];
  if (given !== secret) return json(res, 401, { error: "unauthorized" });

  const body = await readJson(req);
  const { email, password, tenantName, clientName, industry, fiscalMonth } = body || {};
  if (!email || !tenantName || !clientName) {
    return json(res, 400, { error: "invalid_body", required: ["email", "tenantName", "clientName"] });
  }

  // 主アカウント + 追加アカウント をひとつの配列にまとめて同じ手順で処理する
  const requested = [
    { email, password, role: "staff", displayName: body.displayName, gwRoles: body.gwRoles },
    ...(Array.isArray(body.accounts) ? body.accounts : []),
  ];
  for (const a of requested) {
    if (!a?.email) return json(res, 400, { error: "invalid_account", hint: "accounts[].email は必須です" });
    const role = a.role || "client";
    if (!MEMBERSHIP_ROLES.includes(role)) {
      return json(res, 400, { error: "invalid_role", value: role, allowed: MEMBERSHIP_ROLES });
    }
    for (const g of a.gwRoles || []) {
      if (!GW_ROLES.includes(g)) return json(res, 400, { error: "invalid_gw_role", value: g, allowed: GW_ROLES });
    }
  }

  const sb = admin();
  const created = { bucket: false, tenant: false, client: false };

  try {
    // 1) documents バケット（非公開）
    const bucket = "documents";
    const { data: buckets } = await sb.storage.listBuckets();
    if (!buckets?.some((b) => b.name === "documents")) {
      const { error: be } = await sb.storage.createBucket("documents", { public: false });
      if (be && !/already exists/i.test(be.message || "")) {
        return json(res, 500, { error: "bucket_create_failed", detail: be.message });
      }
      created.bucket = true;
    }

    // 2) tenant（同名があれば再利用）
    const tenantId = await ensureRow(sb, "tenants",
      { name: tenantName },
      { name: tenantName },
      created, "tenant");

    // 3) client（同一 tenant 内で同名があれば再利用）
    const clientId = await ensureRow(sb, "clients",
      { tenant_id: tenantId, name: clientName },
      {
        tenant_id: tenantId,
        name: clientName,
        industry: industry || null,
        fiscal_month: fiscalMonth || null,
        accounting_software: "mf",
      },
      created, "client");

    // 4) アカウントごとに Auth ユーザー / メンバーシップ / 社員名簿
    const accounts = [];
    for (const a of requested) {
      const role = a.role || "client";
      const flags = { user: false, passwordUpdated: false, membership: false, employee: false, gwRoles: [] };

      const userId = await findOrCreateUser(sb, a.email, a.password, flags);
      if (!userId) {
        accounts.push({
          email: a.email, role, ok: false, error: "user_not_found",
          hint: "password を指定して作成するか、先に Supabase Auth でユーザーを作ってください",
        });
        continue;
      }

      const membershipId = await ensureRow(sb, "memberships",
        { user_id: userId, tenant_id: tenantId, role },
        role === "client"
          ? { user_id: userId, tenant_id: tenantId, role, client_id: clientId }
          : { user_id: userId, tenant_id: tenantId, role },
        flags, "membership");

      // 社員名簿は 005 未適用の環境では作れない。失敗しても致命的ではないので握りつぶす。
      const employee = await ensureEmployee(sb, tenantId, userId, a, flags);

      accounts.push({
        email: a.email, role, userId, membershipId,
        employeeId: employee?.id || null,
        gwRoles: flags.gwRoles,
        created: flags,
        ok: true,
      });
    }

    return json(res, 200, {
      ok: accounts.every((a) => a.ok),
      tenantId, clientId, bucket,
      accounts,
      created,
      next: "home.html を開き、各アカウントでログインしてください（staff/admin は管理者画面、client はメンバー画面）",
    });
  } catch (err) {
    return json(res, 500, { error: "setup_failed", detail: String(err?.message || err) });
  }
}

// Auth ユーザーを email で探す。無ければ password 指定時のみ作成。
// 既存ユーザーに password が指定されていればパスワードを更新する（デモ用の作り直しを想定）。
async function findOrCreateUser(sb, email, password, flags) {
  const target = String(email).toLowerCase();
  let found = null;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("listUsers: " + error.message);
    found = (data?.users || []).find((u) => (u.email || "").toLowerCase() === target);
    if (found) break;
    if (!data?.users?.length || data.users.length < 200) break; // 最終ページ
  }

  if (found) {
    if (password) {
      const { error } = await sb.auth.admin.updateUserById(found.id, { password, email_confirm: true });
      if (error) throw new Error("updateUser: " + error.message);
      flags.passwordUpdated = true;
    }
    return found.id;
  }

  if (password) {
    const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error("createUser: " + error.message);
    flags.user = true;
    return data.user.id;
  }
  return null;
}

// 社員名簿の行と社内ロールを用意する。005 未適用なら何もしない。
async function ensureEmployee(sb, tenantId, userId, a, flags) {
  const displayName = a.displayName || String(a.email).split("@")[0];
  const { data: existing, error: se } = await sb
    .from("gw_employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (se) return null; // テーブル未作成など。会計側には影響しない

  let employee = existing;
  if (!employee?.id) {
    const { data: ins, error: ie } = await sb
      .from("gw_employees")
      .insert({ tenant_id: tenantId, user_id: userId, display_name: displayName, email: a.email, status: "active" })
      .select("id")
      .single();
    if (ie) return null;
    employee = ins;
    flags.employee = true;
  }

  for (const role of a.gwRoles || []) {
    const { error } = await sb
      .from("gw_role_grants")
      .upsert({ tenant_id: tenantId, employee_id: employee.id, role }, { onConflict: "employee_id,role" });
    if (!error) flags.gwRoles.push(role);
  }
  return employee;
}

// match で既存を探し、無ければ insertData で作成。id を返す。
async function ensureRow(sb, table, match, insertData, created, flag) {
  let q = sb.from(table).select("id");
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
  const { data: existing, error: se } = await q.limit(1).maybeSingle();
  if (se) throw new Error(`${table} select: ${se.message}`);
  if (existing?.id) return existing.id;

  const { data: ins, error: ie } = await sb.from(table).insert(insertData).select("id").single();
  if (ie) throw new Error(`${table} insert: ${ie.message}`);
  created[flag] = true;
  return ins.id;
}
