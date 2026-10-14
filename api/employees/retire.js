// 退職手続き（メンバー管理の「退職手続き」）。人事・管理者だけ。
//
// GET  /api/employees/retire?employeeId=…
//        … その人の退職手続き：退職日・退職理由・書類の一覧（版の履歴つき）・進み具合
// GET  /api/employees/retire?docId=…[&download=1]
//        … 書類の PDF を見る URL（5分だけ有効。管理者が見た記録を残す）
// POST /api/employees/retire {action:"reason", employeeId, reasonCode, reasonNote}
//        … 退職理由（構造化）。退職証明書には、発行のたびに「含める／含めない」を選ぶ（自動では印字しない）
// POST /api/employees/retire {action:"progress", employeeId, kind, state:"processing"|"none", expectedOn?}
//        … 手続き中（ファイルの無い行）にする／戻す。本人には「手続き中」「発行予定」と見える
// POST /api/employees/retire {action:"upload", employeeId, kind, mimeType, sizeBytes}
//        … PDF の置き場所（signed upload URL）
// POST /api/employees/retire {action:"register", employeeId, kind, path, issuedOn?, filename?}
//        … 置いた PDF を確かめて「発行済み」で登録する（公開はしない。再登録は新しい版。古い版は置き換え済みで残す）
// POST /api/employees/retire {action:"publish"|"unpublish", docId}
//        … 本人への公開／公開停止（発行済みの版だけ公開できる）
//
// ■ 発行済みの PDF は、直接上書きしない
//   修正は「再登録（再発行）」＝新しい版。古い版は消さず、履歴として残す。本人に見えるのは、公開中の最新の版だけ。
//
// ■ 記録（操作ログ）
//   退職理由の変更・手続き中の変更・登録・公開・公開停止・管理者の閲覧。印影・本文・URL は残さない。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { detectDoc, DOC_MAX_BYTES } from "../../lib/hr-docs.js";
import {
  KINDS, KIND_KEYS, REASONS, REASON_KEYS, kindLabel, liveOf, adminState, progressOf,
  retirePath, ownsPath, downloadName,
} from "../../lib/retire.js";
import { ymd } from "../../lib/jst.js";
import { putIssued, viewDoc } from "../../lib/retire-store.js";

const BUCKET = "hr";
const TTL = 60 * 5;
const SQL = "db/121_retire_docs.sql";
const DOC_FIELDS = "id, tenant_id, employee_id, kind, version, state, expected_on, note, issued_no, issued_on, issued_by, "
  + "file_name, file_size, include_reason, published, published_at, revoked_at, created_at, updated_at";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s));

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  // 個人情報を返す。対象の人は二段階認証（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = admin();
  try {
    if (req.method === "GET") return await read(req, res, sb, ctx, user);
    if (req.method === "POST") return await act(req, res, sb, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[employees/retire]", e?.message || e);
    return json(res, 500, { error: "retire_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function loadEmployee(sb, ctx, id) {
  if (!id) return null;
  return must(sb.from("gw_employees")
    .select("id, tenant_id, display_name, employment_type, joined_on, left_on, status")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
}

const view = viewDoc;

async function read(req, res, sb, ctx, user) {
  const q = new URL(req.url, "http://localhost").searchParams;
  if (q.get("docId")) return fileUrl(res, sb, ctx, user, q.get("docId"), q.get("download") === "1");

  const emp = await loadEmployee(sb, ctx, q.get("employeeId"));
  if (!emp) return json(res, 404, { error: "not_found" });
  const [c, rows] = await Promise.all([
    must(sb.from("gw_retire_cases").select("reason_code, reason_note, updated_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).maybeSingle()),
    must(sb.from("gw_retire_docs").select(DOC_FIELDS)
      .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).order("version", { ascending: false })),
  ]);
  const docs = rows || [];
  const prog = progressOf(emp, docs);
  return json(res, 200, {
    employee: { id: emp.id, name: emp.display_name, employmentType: emp.employment_type, joinedOn: emp.joined_on, leftOn: emp.left_on, status: emp.status },
    reason: { code: c?.reason_code || null, note: c?.reason_note || "" },
    reasons: REASONS,
    kinds: KINDS.map((k) => {
      const live = liveOf(docs, k.key);
      return {
        kind: k.key, label: k.label, icon: k.icon,
        current: live ? view(live) : null, adminState: adminState(live),
        history: docs.filter((d) => d.kind === k.key).map(view),
      };
    }),
    progress: prog,
  });
}

async function fileUrl(res, sb, ctx, user, docId, download) {
  const d = await must(sb.from("gw_retire_docs")
    .select("id, tenant_id, employee_id, kind, version, state, issued_on, storage_path")
    .eq("id", docId).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!d || !d.storage_path || (d.state !== "issued" && d.state !== "superseded")) return json(res, 404, { error: "not_found" });
  const emp = await loadEmployee(sb, ctx, d.employee_id);
  const name = downloadName(d.kind, emp?.display_name, d.issued_on);
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(d.storage_path, TTL, download ? { download: name } : undefined);
  if (error || !data?.signedUrl) return json(res, 404, { error: "file_missing" });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "retire.admin_view",
    target: `employee:${d.employee_id}`, detail: { docId: d.id, kind: d.kind, version: d.version, download },
  });
  return json(res, 200, { url: data.signedUrl, filename: name, download, expiresIn: TTL });
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  const action = String(body?.action || "");
  const now = new Date().toISOString();

  // 書類の id から始まる操作（公開・公開停止）
  if (action === "publish" || action === "unpublish") {
    const d = await must(sb.from("gw_retire_docs").select(DOC_FIELDS)
      .eq("id", String(body.docId || "")).eq("tenant_id", ctx.tenantId).maybeSingle());
    if (!d) return json(res, 404, { error: "not_found" });
    if (action === "publish") {
      if (d.state !== "issued") return json(res, 409, { error: "not_issued", hint: "発行済みの書類だけ、本人に公開できます" });
      const live = liveOf(await must(sb.from("gw_retire_docs").select("id, kind, version, state")
        .eq("tenant_id", ctx.tenantId).eq("employee_id", d.employee_id)), d.kind);
      if (live?.id !== d.id) return json(res, 409, { error: "not_latest", hint: "最新の版だけ公開できます" });
      await must(sb.from("gw_retire_docs").update({ published: true, published_at: now, published_by: user.id, updated_at: now })
        .eq("id", d.id).eq("tenant_id", ctx.tenantId).select("id").maybeSingle());
    } else {
      await must(sb.from("gw_retire_docs").update({ published: false, revoked_at: now, revoked_by: user.id, updated_at: now })
        .eq("id", d.id).eq("tenant_id", ctx.tenantId).select("id").maybeSingle());
    }
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: action === "publish" ? "retire.publish" : "retire.unpublish",
      target: `employee:${d.employee_id}`, detail: { docId: d.id, kind: d.kind, version: d.version },
    });
    return json(res, 200, { ok: true });
  }

  const emp = await loadEmployee(sb, ctx, body?.employeeId);
  if (!emp) return json(res, 404, { error: "not_found" });
  const kind = KIND_KEYS.includes(body?.kind) ? body.kind : null;

  if (action === "reason") {
    const code = body.reasonCode ? String(body.reasonCode) : null;
    if (code && !REASON_KEYS.includes(code)) return json(res, 400, { error: "invalid_reason", hint: "退職理由を選び直してください" });
    const note = String(body.reasonNote || "").slice(0, 500);
    await must(sb.from("gw_retire_cases").upsert({
      tenant_id: ctx.tenantId, employee_id: emp.id, reason_code: code, reason_note: note || null, updated_by: user.id, updated_at: now,
    }, { onConflict: "employee_id" }).select("id").maybeSingle());
    // 退職理由は個人情報。ログには「変えた」ことと分類だけ（自由記述は残さない）
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "retire.reason",
      target: `employee:${emp.id}`, detail: { reasonCode: code },
    });
    return json(res, 200, { ok: true });
  }

  if (!kind) return json(res, 400, { error: "invalid_kind", hint: "書類の種類を選んでください" });

  if (action === "progress") {
    const live = liveOf(await must(sb.from("gw_retire_docs").select("id, kind, version, state, expected_on")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id)), kind);
    const state = body.state === "processing" ? "processing" : body.state === "none" ? "none" : null;
    if (!state) return json(res, 400, { error: "invalid_state" });
    if (body.expectedOn && !isDate(body.expectedOn)) return json(res, 400, { error: "invalid_date", hint: "発行予定日を日付で入れてください" });
    if (live && live.state !== "processing") {
      // 発行済み・下書きの行を、手続き中で上書きしない
      return json(res, 409, { error: "already_has_doc", hint: "すでに書類があります。置き換えるときは、新しい書類を登録してください" });
    }
    if (state === "processing") {
      if (live) {
        await must(sb.from("gw_retire_docs").update({ expected_on: body.expectedOn || null, updated_at: now })
          .eq("id", live.id).eq("tenant_id", ctx.tenantId).select("id").maybeSingle());
      } else {
        await must(sb.from("gw_retire_docs").insert({
          tenant_id: ctx.tenantId, employee_id: emp.id, kind, version: 1, state: "processing",
          expected_on: body.expectedOn || null, created_by: user.id, created_at: now, updated_at: now,
        }).select("id").single());
      }
    } else if (live) {
      await must(sb.from("gw_retire_docs").delete().eq("id", live.id).eq("tenant_id", ctx.tenantId).select("id"));
    }
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "retire.progress", target: `employee:${emp.id}`, detail: { kind, state } });
    return json(res, 200, { ok: true });
  }

  if (action === "upload") {
    if (String(body.mimeType || "") !== "application/pdf") return json(res, 400, { error: "unsupported_file", hint: "PDF を選んでください" });
    if (!(Number(body.sizeBytes) > 0)) return json(res, 400, { error: "no_file", hint: "ファイルを選んでください" });
    if (Number(body.sizeBytes) > DOC_MAX_BYTES) return json(res, 400, { error: "file_too_large", hint: "ファイルは10MBまでにしてください" });
    const path = retirePath(ctx.tenantId, emp.id, kind, crypto.randomUUID());
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return json(res, 500, { error: "sign_failed", detail: error.message });
    return json(res, 200, { path, uploadUrl: data.signedUrl, token: data.token });
  }

  if (action === "register") {
    const path = String(body.path || "");
    // 置き場所を自分で指定できてしまうと、他の人・他社・契約書のファイルを掴める
    if (!ownsPath(path, ctx.tenantId, emp.id, kind)) return json(res, 403, { error: "forbidden" });
    const issuedOn = body.issuedOn ? String(body.issuedOn) : ymd();
    if (!isDate(issuedOn)) return json(res, 400, { error: "invalid_date", hint: "発行日を日付で入れてください" });
    const dl = await sb.storage.from(BUCKET).download(path);
    if (dl.error || !dl.data) return json(res, 400, { error: "no_file", hint: "置いたファイルを読めませんでした" });
    const bytes = Buffer.from(await dl.data.arrayBuffer());
    if (detectDoc(bytes) !== "pdf") {
      await sb.storage.from(BUCKET).remove([path]);
      return json(res, 400, { error: "unsupported_file", hint: "PDF を選んでください" });
    }
    let done;
    try {
      done = await putIssued(sb, ctx, user, emp, kind, {
        path, sha256: sha256(bytes), size: bytes.length, issuedOn, fileName: body.filename,
      });
    } catch (e) {
      await sb.storage.from(BUCKET).remove([path]);
      throw e;
    }
    const { row, live } = done;
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: live?.state === "issued" ? "retire.reissue" : "retire.register",
      target: `employee:${emp.id}`, detail: { docId: row.id, kind, version: row.version, supersedes: live?.id || null },
    });
    return json(res, 200, { document: view(row) });
  }

  return json(res, 400, { error: "invalid_action", detail: "reason, progress, upload, register, publish, unpublish" });
}
