// POST /api/admin/setup
// 実データ版の初期ブートストラップ（1回だけ実行する想定）。
//   - documents ストレージバケット（非公開）を作成
//   - 事務所(tenant) / 顧問先(client) / メンバーシップ(staff) を作成
//   - Auth ユーザーが無ければ（password 指定時のみ）作成
//
// セキュリティ:
//   - 環境変数 SETUP_SECRET が未設定なら無効（503）。
//   - リクエストヘッダ x-setup-secret が SETUP_SECRET と一致しない限り拒否（401）。
//   - service_role を使うため RLS をバイパスする。使用後は SETUP_SECRET を外す/エンドポイントを消す運用推奨。
//
// 入力: { email, password?, tenantName, clientName, industry?, fiscalMonth? }
// 出力: { tenantId, clientId, userId, membershipId, bucket, created:{...} }

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";

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

  const sb = admin();
  const created = { bucket: false, user: false, tenant: false, client: false, membership: false };

  try {
    // 1) documents バケット（非公開）
    let bucket = "documents";
    const { data: buckets } = await sb.storage.listBuckets();
    if (!buckets?.some((b) => b.name === "documents")) {
      const { error: be } = await sb.storage.createBucket("documents", { public: false });
      if (be && !/already exists/i.test(be.message || "")) {
        return json(res, 500, { error: "bucket_create_failed", detail: be.message });
      }
      created.bucket = true;
    }

    // 2) Auth ユーザーの解決（無ければ password 指定時のみ作成）
    const userId = await findOrCreateUser(sb, email, password, created);
    if (!userId) {
      return json(res, 400, {
        error: "user_not_found",
        hint: "Supabase Auth に該当ユーザーが居ません。password を指定して作成するか、先に Auth でユーザーを作ってください",
        email,
      });
    }

    // 3) tenant（同名があれば再利用）
    const tenantId = await ensureRow(sb, "tenants",
      { name: tenantName },
      { name: tenantName },
      created, "tenant");

    // 4) client（同一 tenant 内で同名があれば再利用）
    const clientInsert = {
      tenant_id: tenantId,
      name: clientName,
      industry: industry || null,
      fiscal_month: fiscalMonth || null,
      accounting_software: "mf",
    };
    const clientId = await ensureRow(sb, "clients",
      { tenant_id: tenantId, name: clientName },
      clientInsert,
      created, "client");

    // 5) membership（staff）: 同一 (user, tenant) があれば再利用
    const membershipId = await ensureRow(sb, "memberships",
      { user_id: userId, tenant_id: tenantId, role: "staff" },
      { user_id: userId, tenant_id: tenantId, role: "staff" },
      created, "membership");

    return json(res, 200, {
      ok: true,
      tenantId, clientId, userId, membershipId, bucket,
      created,
      next: "app.html を開き、この email でログイン → 取引先『" + clientName + "』を選んで書類をアップロードできます",
    });
  } catch (err) {
    return json(res, 500, { error: "setup_failed", detail: String(err?.message || err) });
  }
}

// Auth ユーザーを email で探す。無ければ password 指定時のみ作成。
async function findOrCreateUser(sb, email, password, created) {
  const target = String(email).toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("listUsers: " + error.message);
    const hit = (data?.users || []).find((u) => (u.email || "").toLowerCase() === target);
    if (hit) return hit.id;
    if (!data?.users?.length || data.users.length < 200) break; // 最終ページ
  }
  if (password) {
    const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error("createUser: " + error.message);
    created.user = true;
    return data.user.id;
  }
  return null;
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
