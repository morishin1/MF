// /sales 業種・提案サービスの選択肢（テナントごと。db/108 gw_sales_master_options）
//
// GET   /api/sales/masters                      … 選択肢すべて（非表示を含む）と、それぞれを使っている企業数
// POST  /api/sales/masters { kind, label }      … 追加（kind：industry / service）
// PATCH /api/sales/masters { id, label }        … 名前変更。その名前を使っている企業も新しい名前にそろえる
// PATCH /api/sales/masters { id, archived }     … 非表示（true）・再表示（false）。企業のデータは変えない
//
// ■ 物理削除はしない（非表示だけ）。非表示の値を持つ企業は、一覧の絞り込みで「旧データ」として選べる
// ■ そのテナントにまだ行が無い種類は、最初に既定値（lib/sales-master.js DEFAULT_*）を入れてから扱う
// ■ 使えるのは営業の人だけ（RLS も gw_is_sales）。操作は監査ログに残す

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { isUuid } from "../../../lib/sales.js";
import { DEFAULT_INDUSTRIES, DEFAULT_SERVICES, MASTER_KINDS, MASTER_LABEL_MAX } from "../../../lib/sales-master.js";

const SQL = "db/108_sales_masters_emails.sql";
const TABLE = "gw_sales_master_options";
const FIELDS = "id, kind, label, sort_order, archived_at";
const DEFAULTS = { industry: DEFAULT_INDUSTRIES, service: DEFAULT_SERVICES };
const KIND_LABEL = { industry: "業種", service: "提案サービス" };

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  if (req.method === "GET") return list(res, sb, ctx, user);
  if (req.method === "POST") return add(req, res, sb, ctx, user);
  if (req.method === "PATCH") return update(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

const dbError = (res, error) => {
  const hint = dbSetupHint(error, SQL);
  if (hint) return json(res, 503, { error: "not_ready", message: hint });
  return json(res, error.code === "42501" ? 403 : 500, { error: "db_failed", detail: error.message });
};

/** まだ行が無い種類に既定値を入れる（名前変更・非表示を行として持てるように） */
async function ensureSeeded(sb, ctx, user) {
  const { data, error } = await sb.from(TABLE).select("kind").eq("tenant_id", ctx.tenantId);
  if (error) return { error };
  const have = new Set((data || []).map((r) => r.kind));
  const rows = [];
  for (const kind of MASTER_KINDS) {
    if (have.has(kind)) continue;
    DEFAULTS[kind].forEach((label, i) => rows.push({
      tenant_id: ctx.tenantId, kind, label, sort_order: (i + 1) * 10, created_by: user.id, updated_by: user.id,
    }));
  }
  if (!rows.length) return {};
  const { error: e2 } = await sb.from(TABLE).insert(rows);
  // 同時に別の人が入れた（23505）なら、それでよい
  return e2 && e2.code !== "23505" ? { error: e2 } : {};
}

async function list(res, sb, ctx, user) {
  const seeded = await ensureSeeded(sb, ctx, user);
  if (seeded.error) return dbError(res, seeded.error);
  const [{ data, error }, { data: cos }] = await Promise.all([
    sb.from(TABLE).select(FIELDS).eq("tenant_id", ctx.tenantId)
      .order("kind").order("sort_order", { ascending: true }).order("label", { ascending: true }),
    sb.from("gw_sales_companies").select("industry, service").eq("tenant_id", ctx.tenantId).limit(50000),
  ]);
  if (error) return dbError(res, error);
  const used = { industry: new Map(), service: new Map() };
  for (const c of cos || []) {
    for (const kind of MASTER_KINDS) {
      const v = c[kind];
      if (v) used[kind].set(v, (used[kind].get(v) || 0) + 1);
    }
  }
  return json(res, 200, {
    kinds: MASTER_KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] })),
    options: (data || []).map((r) => ({
      id: r.id, kind: r.kind, label: r.label, sortOrder: r.sort_order, archived: Boolean(r.archived_at),
      used: used[r.kind]?.get(r.label) || 0,
    })),
  });
}

function cleanLabel(v) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { error: "label_required", hint: "名前を入力してください" };
  if (s.length > MASTER_LABEL_MAX) return { error: "label_too_long", hint: `名前は${MASTER_LABEL_MAX}文字までです` };
  return { label: s };
}

async function add(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!MASTER_KINDS.includes(body.kind)) return json(res, 400, { error: "bad_kind" });
  const l = cleanLabel(body.label);
  if (l.error) return json(res, 400, l);
  const seeded = await ensureSeeded(sb, ctx, user);
  if (seeded.error) return dbError(res, seeded.error);

  const { data: same } = await sb.from(TABLE).select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("kind", body.kind).eq("label", l.label).limit(1);
  if (same?.length) {
    return json(res, 409, {
      error: "duplicate", option: { id: same[0].id, archived: Boolean(same[0].archived_at) },
      hint: same[0].archived_at ? `「${l.label}」は非表示にしてあります。再表示してください` : `「${l.label}」はもうあります`,
    });
  }
  const { data: last } = await sb.from(TABLE).select("sort_order").eq("tenant_id", ctx.tenantId).eq("kind", body.kind)
    .order("sort_order", { ascending: false }).limit(1);
  const { data, error } = await sb.from(TABLE).insert({
    tenant_id: ctx.tenantId, kind: body.kind, label: l.label, sort_order: (last?.[0]?.sort_order || 0) + 10,
    created_by: user.id, updated_by: user.id,
  }).select(FIELDS).single();
  if (error) {
    if (error.code === "23505") return json(res, 409, { error: "duplicate", hint: `「${l.label}」はもうあります` });
    return dbError(res, error);
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.master_add",
    target: `sales_master:${data.id}`, detail: { kind: data.kind, label: data.label } });
  return json(res, 200, { option: { id: data.id, kind: data.kind, label: data.label, sortOrder: data.sort_order, archived: false } });
}

async function update(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const { data: rows, error: e0 } = await sb.from(TABLE).select(FIELDS).eq("tenant_id", ctx.tenantId).eq("id", body.id).limit(1);
  if (e0) return dbError(res, e0);
  const before = rows?.[0];
  if (!before) return json(res, 404, { error: "not_found" });
  const now = new Date().toISOString();

  // 非表示・再表示（企業のデータはそのまま）
  if (typeof body.archived === "boolean" && body.label === undefined) {
    const { error } = await sb.from(TABLE).update({ archived_at: body.archived ? now : null, updated_by: user.id, updated_at: now })
      .eq("tenant_id", ctx.tenantId).eq("id", before.id);
    if (error) return dbError(res, error);
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: body.archived ? "sales.master_archive" : "sales.master_restore",
      target: `sales_master:${before.id}`, detail: { kind: before.kind, label: before.label } });
    return json(res, 200, { ok: true });
  }

  // 名前変更。その名前を使っている企業も新しい名前へ（同じ分類のまま。送った履歴のサービス名は当時のまま残す）
  const l = cleanLabel(body.label);
  if (l.error) return json(res, 400, l);
  if (l.label === before.label) return json(res, 200, { ok: true, companies: 0 });
  const { data: same } = await sb.from(TABLE).select("id")
    .eq("tenant_id", ctx.tenantId).eq("kind", before.kind).eq("label", l.label).limit(1);
  if (same?.length) return json(res, 409, { error: "duplicate", hint: `「${l.label}」はもうあります` });
  const { error } = await sb.from(TABLE).update({ label: l.label, updated_by: user.id, updated_at: now })
    .eq("tenant_id", ctx.tenantId).eq("id", before.id);
  if (error) {
    if (error.code === "23505") return json(res, 409, { error: "duplicate", hint: `「${l.label}」はもうあります` });
    return dbError(res, error);
  }
  const col = before.kind;   // industry / service は企業の列名と同じ
  const { data: moved, error: e2 } = await sb.from("gw_sales_companies").update({ [col]: l.label, updated_at: now })
    .eq("tenant_id", ctx.tenantId).eq(col, before.label).select("id");
  if (e2) return dbError(res, e2);
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.master_rename",
    target: `sales_master:${before.id}`, detail: { kind: before.kind, from: before.label, to: l.label, companies: moved?.length || 0 } });
  return json(res, 200, { ok: true, companies: moved?.length || 0 });
}
