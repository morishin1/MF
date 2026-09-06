// GET    /api/onboarding              … 手続きの一覧（見える範囲は RLS が決める）
//          管理者・人事 … 全件 / 本人 … 自分の分 / 社労士 … 共有された項目のみ
// POST   /api/onboarding              … 手続きを新規作成（既定チェックリスト付き）
//          { employeeId, kind?, targetOn?, note? }
// PATCH  /api/onboarding {id, ...}    … 手続きの更新（status / targetOn / note）
// DELETE /api/onboarding?id=...       … 手続きの削除（項目もまとめて消える）

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { defaultChecklist } from "../../lib/onboarding.js";
import { ensureProcedureFolders, shareAdvisorFolder } from "../../lib/hr-drive.js";
import { admin } from "../../lib/supabase.js";

const KINDS = ["onboarding", "offboarding"];
const STATUSES = ["not_started", "in_progress", "done", "cancelled"];

const P_FIELDS =
  "id, tenant_id, employee_id, kind, status, target_on, note, drive_folder_id, drive_link, "
  + "drive_folders, drive_sensitive_folder_id, advisor_shared_to, advisor_shared_at, created_at, updated_at";
const I_FIELDS =
  "id, procedure_id, item_key, title, category, owner, required, share_with_advisor, status, due_on, note, "
  + "sort_order, document_id, completed_at, submitted_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const { data: procedures, error } = await sb
      .from("gw_procedures")
      .select(`${P_FIELDS}, employee:gw_employees(id, display_name, department, position, employment_type, status)`)
      .eq("tenant_id", ctx.tenantId)
      .order("target_on", { ascending: true, nullsFirst: false })
      .limit(200);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    const list = procedures || [];
    if (!list.length) return json(res, 200, { procedures: [], canManage: canManageHr(ctx), me: ctx.employee });

    const { data: items, error: ie } = await sb
      .from("gw_procedure_items")
      .select(I_FIELDS)
      .in("procedure_id", list.map((p) => p.id))
      .order("sort_order", { ascending: true });
    if (ie) return json(res, 500, { error: "db_query_failed", detail: ie.message });

    // 提出ファイル。見える範囲は RLS が決める（本人・人事・共有項目の社労士）
    const { data: files } = await sb
      .from("gw_procedure_files")
      .select("id, procedure_id, item_id, filename, mime_type, drive_link, drive_name, drive_folder_key, created_at")
      .in("procedure_id", list.map((p) => p.id))
      .order("created_at", { ascending: true });
    const byItem = new Map();
    for (const f of files || []) {
      if (!f.item_id) continue;
      if (!byItem.has(f.item_id)) byItem.set(f.item_id, []);
      byItem.get(f.item_id).push(f);
    }

    const byProc = new Map();
    for (const it of items || []) {
      if (!byProc.has(it.procedure_id)) byProc.set(it.procedure_id, []);
      byProc.get(it.procedure_id).push({ ...it, files: byItem.get(it.id) || [] });
    }

    return json(res, 200, {
      procedures: list.map((p) => {
        const its = byProc.get(p.id) || [];
        const done = its.filter((i) => i.status === "done" || i.status === "na").length;
        return { ...p, items: its, progress: { done, total: its.length } };
      }),
      canManage: canManageHr(ctx),
      isAdvisor: ctx.isAdvisor,
      me: ctx.employee,
    });
  }

  if (req.method === "POST") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    const employeeId = body?.employeeId;
    const kind = body?.kind || "onboarding";
    if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });
    if (!KINDS.includes(kind)) return json(res, 400, { error: "invalid_kind", detail: KINDS.join(", ") });

    // 既定チェックリストは雇用区分で変わるので、まず対象者を読む
    const { data: employee, error: ee } = await sb
      .from("gw_employees")
      .select("id, employment_type, display_name")
      .eq("id", employeeId)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (ee) return json(res, 500, { error: "db_query_failed", detail: ee.message });
    if (!employee) return json(res, 404, { error: "employee_not_found" });

    const { data: proc, error } = await sb
      .from("gw_procedures")
      .insert({
        tenant_id: ctx.tenantId,
        employee_id: employeeId,
        kind,
        target_on: body.targetOn || null,
        note: body.note || null,
        created_by: user.id,
      })
      .select(P_FIELDS)
      .single();
    if (error) {
      // 同じ人・同じ種別の手続きは1件だけ
      if (error.code === "23505") return json(res, 409, { error: "procedure_exists" });
      return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    }

    const checklist = defaultChecklist(kind, employee.employment_type).map((it) => ({
      ...it, tenant_id: ctx.tenantId, procedure_id: proc.id,
    }));
    const { data: items, error: ce } = await sb.from("gw_procedure_items").insert(checklist).select(I_FIELDS);
    if (ce) {
      // 項目が入らないと使い物にならないので、手続きごと巻き戻す
      await sb.from("gw_procedures").delete().eq("id", proc.id);
      return json(res, 500, { error: "checklist_insert_failed", detail: ce.message });
    }

    // 個人フォルダ。未設定の環境では作らない。失敗しても手続きは成立させる
    const folder = await attachFolder(sb, ctx.tenantId, proc, employee.display_name);

    return json(res, 200, {
      procedure: {
        ...proc, ...folder,
        items: items || [], progress: { done: 0, total: (items || []).length },
      },
    });
  }

  if (req.method === "PATCH") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

    const patch = { updated_at: new Date().toISOString() };
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return json(res, 400, { error: "invalid_status", detail: STATUSES.join(", ") });
      patch.status = body.status;
    }
    if (body.targetOn !== undefined) patch.target_on = body.targetOn || null;
    if (body.note !== undefined) patch.note = body.note || null;

    // 後から個人フォルダ一式を作る（作成時に Drive 未設定だった手続きの手当て）。
    // 既にルートだけある古い手続きでも、01〜05 と機微情報を足せる
    if (body.createFolder) {
      const { data: cur } = await sb
        .from("gw_procedures")
        .select("id, kind, target_on, drive_folders, employee:gw_employees(display_name)")
        .eq("id", body.id)
        .eq("tenant_id", ctx.tenantId)
        .maybeSingle();
      if (!cur) return json(res, 404, { error: "procedure_not_found" });
      if (cur.drive_folders) return json(res, 409, { error: "folder_exists" });

      const made = await ensureProcedureFolders({
        kind: cur.kind,
        targetOn: body.targetOn !== undefined ? body.targetOn : cur.target_on,
        displayName: cur.employee?.display_name,
      });
      if (made.skipped) {
        return json(res, 400, {
          error: "drive_not_ready",
          hint: made.skipped === "not_configured"
            ? "Vercel に GDRIVE_HR_FOLDER_ID を設定してください"
            : "対象者の氏名が取得できませんでした",
        });
      }
      patch.drive_folder_id = made.folderId;
      patch.drive_link = made.link;
      patch.drive_folders = made.folders;
      patch.drive_sensitive_folder_id = made.sensitiveFolderId;
    }

    // 社労士に 04_社会保険・労務 だけを共有する。
    // 個人フォルダのルートは渡さない（渡すと全部付いてくる）。
    // 機微情報は別の木にあるので、そもそも届かない
    if (body.shareAdvisor) {
      const email = String(body.shareAdvisor).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(res, 400, { error: "invalid_email", hint: "社労士のメールアドレスを入れてください" });
      }
      const { data: cur } = await admin().from("gw_procedures")
        .select("drive_folders").eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
      if (!cur?.drive_folders) {
        return json(res, 400, { error: "no_folders", hint: "先に個人フォルダを作ってください" });
      }
      try {
        const r = await shareAdvisorFolder(cur.drive_folders, email);
        if (r.skipped) return json(res, 400, { error: "drive_not_ready", hint: "Drive が設定されていません" });
      } catch (e) {
        return json(res, 502, { error: "share_failed", hint: String(e.message).slice(0, 200) });
      }
      patch.advisor_shared_to = email;
      patch.advisor_shared_at = new Date().toISOString();
    }

    const { data, error } = await sb
      .from("gw_procedures")
      .update(patch)
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .select(P_FIELDS)
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "procedure_not_found" });
    return json(res, 200, { procedure: data });
  }

  if (req.method === "DELETE") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { data, error } = await sb
      .from("gw_procedures")
      .delete()
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .select("id")
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "procedure_not_found" });
    return json(res, 200, { ok: true, id });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

// 個人フォルダを用意して手続きに記録する。
// Drive 未設定や一時的な失敗で手続きの作成まで巻き戻さないよう、握りつぶす。
async function attachFolder(sb, tenantId, proc, displayName) {
  try {
    const made = await ensureProcedureFolders({
      kind: proc.kind, targetOn: proc.target_on, displayName,
    });
    if (made.skipped) return {};

    const patch = {
      drive_folder_id: made.folderId, drive_link: made.link,
      drive_folders: made.folders, drive_sensitive_folder_id: made.sensitiveFolderId,
    };
    await sb.from("gw_procedures").update(patch).eq("id", proc.id).eq("tenant_id", tenantId);
    return patch;
  } catch (e) {
    console.error("[onboarding] drive folder failed:", e?.message || e);
    return {};
  }
}
