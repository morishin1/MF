// GET    /api/notices?scope=admin   … お知らせ一覧
//          既定（scope 省略）… 自分に配信されている公開中のお知らせ＋自分の既読状態
//          scope=admin        … 下書き・期限切れも含む全件＋既読人数（管理者のみ）
// POST   /api/notices                … 作成
// PATCH  /api/notices  {id, ...}     … 更新
// DELETE /api/notices?id=...         … 削除
//
// 権限はすべて RLS（db/007_notices.sql）で担保する。
// anon key と JWT はブラウザにあるため、この API 層の if は「使い勝手のため」であって
// 境界ではない。書き込みも userClient 経由にして with check を必ず通す。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships } from "../../lib/auth.js";
import { userClient, admin } from "../../lib/supabase.js";
import { notifySlack } from "../../lib/slack.js";

const CATEGORIES = ["general", "important", "system", "event"];
const AUDIENCES = ["all", "department"];
const STATUSES = ["draft", "published", "archived"];

const FIELDS =
  "id, tenant_id, title, body, category, audience, departments, pinned, status, publish_at, expires_at, created_by, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const memberships = await getMemberships(user.id);
  if (!memberships.length) return json(res, 403, { error: "no_membership" });

  const staff = memberships.find((m) => m.role === "admin" || m.role === "staff");
  const tenantId = (staff || memberships[0]).tenant_id;
  const isAdmin = !!staff;

  const sb = userClient(req);

  if (req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const adminScope = url.searchParams.get("scope") === "admin";
    if (adminScope && !isAdmin) return json(res, 403, { error: "forbidden" });

    let q = sb.from("gw_notices").select(FIELDS).eq("tenant_id", tenantId);
    if (!adminScope) q = q.eq("status", "published");
    const { data, error } = await q
      .order("pinned", { ascending: false })
      .order("publish_at", { ascending: false })
      .limit(200);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    const notices = data || [];
    if (!notices.length) return json(res, 200, { notices: [], unread: 0, isAdmin });

    return adminScope
      ? json(res, 200, { notices: await withReadCounts(tenantId, notices), isAdmin })
      : json(res, 200, await withMyReadState(tenantId, user.id, notices, isAdmin));
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, { error: row.error, detail: row.detail });

    const { data, error } = await sb
      .from("gw_notices")
      .insert({ ...row.value, tenant_id: tenantId, created_by: user.id })
      .select(FIELDS)
      .single();
    if (error) return json(res, insertStatus(error), { error: "db_insert_failed", detail: error.message });
    await announceToSlack(data);
    return json(res, 200, { notice: data });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
    const row = normalize(body, { partial: true });
    if (row.error) return json(res, 400, { error: row.error, detail: row.detail });

    const { data, error } = await sb
      .from("gw_notices")
      .update({ ...row.value, updated_at: new Date().toISOString() })
      .eq("id", body.id)
      .eq("tenant_id", tenantId)
      .select(FIELDS)
      .maybeSingle();
    if (error) return json(res, insertStatus(error), { error: "db_update_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "notice_not_found" });
    // 下書きから配信に切り替えたときにも1回だけ流す
    if (row.value.status === "published") await announceToSlack(data);
    return json(res, 200, { notice: data });
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { data, error } = await sb
      .from("gw_notices")
      .delete()
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .select("id")
      .maybeSingle();
    if (error) return json(res, insertStatus(error), { error: "db_delete_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "notice_not_found" });
    return json(res, 200, { ok: true, id });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

// RLS で弾かれた場合、PostgREST は行が無いのと同じ形で返ってくることがある。
// 42501（権限不足）は 403 として返し、原因を分かるようにする。
function insertStatus(error) {
  return error?.code === "42501" ? 403 : 500;
}

// 入力の検証と正規化。partial=true のときは渡された項目だけを対象にする。
function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined && body[k] !== null;

  if (!partial || has("title")) {
    const title = String(body.title ?? "").trim();
    if (!title) return { error: "invalid_body", detail: "title は必須です" };
    if (title.length > 200) return { error: "invalid_body", detail: "title は200文字までです" };
    v.title = title;
  }
  if (!partial || has("body")) {
    const text = String(body.body ?? "").trim();
    if (!text) return { error: "invalid_body", detail: "body は必須です" };
    v.body = text;
  }
  if (has("category")) {
    if (!CATEGORIES.includes(body.category)) return { error: "invalid_category", detail: CATEGORIES.join(", ") };
    v.category = body.category;
  }
  if (has("status")) {
    if (!STATUSES.includes(body.status)) return { error: "invalid_status", detail: STATUSES.join(", ") };
    v.status = body.status;
  }
  if (has("audience")) {
    if (!AUDIENCES.includes(body.audience)) return { error: "invalid_audience", detail: AUDIENCES.join(", ") };
    v.audience = body.audience;
  }
  if (has("departments")) {
    if (!Array.isArray(body.departments)) return { error: "invalid_departments", detail: "配列で指定してください" };
    v.departments = body.departments.map((d) => String(d).trim()).filter(Boolean);
  }
  // 部署宛てなのに宛先が空だと誰にも届かない。作成時に気づけるようにする
  if (v.audience === "department" && !partial && !v.departments?.length) {
    return { error: "invalid_departments", detail: "部署宛ての場合は対象部署を1つ以上選んでください" };
  }
  if (has("pinned")) v.pinned = !!body.pinned;
  if (has("publish_at")) v.publish_at = body.publish_at;
  if (body.expires_at !== undefined) v.expires_at = body.expires_at || null;

  return { value: v };
}

// 管理者向け: 既読人数と、配信対象の人数
async function withReadCounts(tenantId, notices) {
  const sb = admin();
  const [{ data: reads }, { data: employees }] = await Promise.all([
    sb.from("gw_notice_reads").select("notice_id").eq("tenant_id", tenantId),
    sb.from("gw_employees").select("department").eq("tenant_id", tenantId).eq("status", "active"),
  ]);

  const counts = new Map();
  for (const r of reads || []) counts.set(r.notice_id, (counts.get(r.notice_id) || 0) + 1);

  const staffList = employees || [];
  return notices.map((n) => ({
    ...n,
    readCount: counts.get(n.id) || 0,
    targetCount: n.audience === "all"
      ? staffList.length
      : staffList.filter((e) => (n.departments || []).includes(e.department || "")).length,
  }));
}

// メンバー向け: 自分の既読状態を添える
async function withMyReadState(tenantId, userId, notices, isAdmin) {
  const sb = admin();
  const { data: employee } = await sb
    .from("gw_employees")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();

  // 社員名簿に未登録の場合は既読を扱えない。お知らせ自体は読める
  if (!employee) return { notices: notices.map((n) => ({ ...n, read: false })), unread: 0, isAdmin, enrolled: false };

  const { data: reads } = await sb
    .from("gw_notice_reads")
    .select("notice_id")
    .eq("employee_id", employee.id);

  const readSet = new Set((reads || []).map((r) => r.notice_id));
  const withState = notices.map((n) => ({ ...n, read: readSet.has(n.id) }));
  return {
    notices: withState,
    unread: withState.filter((n) => !n.read).length,
    isAdmin,
    enrolled: true,
    employeeId: employee.id,
  };
}

// 配信したお知らせを Slack にも流す。下書きのうちは流さない。
// SLACK_WEBHOOK_URL が未設定なら何も起きない
async function announceToSlack(notice) {
  if (!notice || notice.status !== "published") return;
  const where = notice.audience === "department"
    ? (notice.departments || []).join("・")
    : "全社";
  await notifySlack({
    text: `:loudspeaker: お知らせ（${where}）　${notice.title}`,
    lines: [String(notice.body || "").slice(0, 300)],
    link: "home.html",
  });
}
