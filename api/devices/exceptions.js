// GET    /api/devices/exceptions              … 私物PC利用の承認を一覧する
// POST   /api/devices/exceptions              … 承認を出す
// PATCH  /api/devices/exceptions {id, action} … 取り消す
//
// ■ なぜ「禁止」だけにしないのか
//
//   業務は原則、会社貸与PCだけ。私物PCでの業務利用は禁止している。
//   ただ、禁止だけを突きつけると、現場は黙って使う。
//   黙って使われるほうが、承認を出すより危ない。
//
//   だから、やむを得ないときの通し方を用意しておく。
//   誰が・どの端末で・なぜ・誰が承認し・いつまで、を残す。
//
// ■ 無期限にはしない
//   期限を切らないと、1回出した承認がそのまま既得権になる。
//   切れたら、また事情を説明してもらう。
//
// ■ 見られるのは人事だけ
//   本人は自分に出ているものだけ読める（RLS）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notify } from "../../lib/notify.js";
import { jstDate, exceptionState } from "../../lib/devices.js";

const SQL = "db/060_device_rules.sql";
const MAX_DAYS = 365;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !ctx.employee) return json(res, 403, { error: "no_membership" });
  // 出すのも読むのも人事。私物を認めるかどうかは、現場で決める話ではない
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return list(res, ctx);
  if (req.method === "POST") return create(req, res, ctx, user);
  if (req.method === "PATCH") return revoke(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

// ---- 読む -------------------------------------------------------------------
async function list(res, ctx) {
  const sb = admin();
  const { data, error } = await sb.from("gw_device_exceptions")
    .select("id, employee_id, device_id, device_note, reason, "
          + "approved_by, approved_at, expires_on, revoked_at, note")
    .eq("tenant_id", ctx.tenantId)
    .order("approved_at", { ascending: false })
    .limit(300);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const people = await employeeMap(sb, ctx.tenantId);
  const today = jstDate();

  return json(res, 200, {
    exceptions: (data || []).map((e) => ({
      id: e.id,
      employee: people.get(e.employee_id) || null,
      deviceId: e.device_id,
      deviceNote: e.device_note,
      reason: e.reason,
      approvedAt: e.approved_at,
      expiresOn: e.expires_on,
      revokedAt: e.revoked_at,
      note: e.note,
      state: exceptionState(e, today),
    })),
  });
}

// ---- 出す -------------------------------------------------------------------
async function create(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();

  const employeeId = String(body.employeeId || "");
  const reason = String(body.reason || "").trim().slice(0, 500);
  const expiresOn = String(body.expiresOn || "");
  const deviceNote = String(body.deviceNote || "").trim().slice(0, 120) || null;
  const deviceId = body.deviceId || null;

  if (!employeeId || !reason || !expiresOn) {
    return json(res, 400, {
      error: "bad_request",
      hint: "対象の社員・理由・利用期限は、どれも省けません",
    });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
    return json(res, 400, { error: "bad_request", hint: "利用期限の形式が違います" });
  }

  const today = jstDate();
  if (expiresOn < today) {
    return json(res, 400, { error: "bad_request", hint: "過ぎた日付では出せません" });
  }
  // 無期限の代わりに遠い日付を入れられると、期限を切った意味がなくなる
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + MAX_DAYS * 86400000)
    .toISOString().slice(0, 10);
  if (expiresOn > limit) {
    return json(res, 400, {
      error: "bad_request",
      hint: `利用期限は ${MAX_DAYS}日先（${limit}）までです。続けるなら、そのとき出し直してください`,
    });
  }

  const { data: emp } = await sb.from("gw_employees")
    .select("id, display_name").eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 400, { error: "bad_employee" });

  const { data: made, error } = await sb.from("gw_device_exceptions").insert({
    tenant_id: ctx.tenantId,
    employee_id: employeeId,
    device_id: deviceId,
    device_note: deviceNote,
    reason,
    approved_by: user.id,
    expires_on: expiresOn,
  }).select("id").single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  // 本人にも知らせる。「いつまで、何のために認められたか」を
  // 本人が持っていないと、期限が来たことに気づけない
  await notify([{
    tenantId: ctx.tenantId,
    employeeId,
    kind: "device_exception",
    title: `私物パソコンでの業務利用が承認されました（${expiresOn} まで）`,
    body: `理由: ${reason}\n期限を過ぎたあとは、会社貸与パソコンをお使いください。`,
    link: "device-consent.html",
    dedupeKey: `device_exception:${made.id}`,
  }]);

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: "device.exception_approved", target: made.id,
    detail: { employeeId, employee: emp.display_name, reason, expiresOn, deviceId, deviceNote },
  });

  return json(res, 200, { ok: true, id: made.id });
}

// ---- 取り消す ---------------------------------------------------------------
async function revoke(req, res, ctx, user) {
  const body = await readJson(req);
  if (String(body.action || "") !== "revoke" || !body.id) {
    return json(res, 400, { error: "bad_request" });
  }
  const sb = admin();

  const { data: e } = await sb.from("gw_device_exceptions")
    .select("id, tenant_id, employee_id, revoked_at")
    .eq("id", body.id).maybeSingle();
  if (!e || e.tenant_id !== ctx.tenantId) return json(res, 404, { error: "not_found" });
  if (e.revoked_at) return json(res, 200, { ok: true, already: true });

  // 行は消さない。出したことも、取り消したことも記録に残す
  const { error } = await sb.from("gw_device_exceptions")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: user.id,
      note: String(body.note || "").trim().slice(0, 300) || null,
    })
    .eq("id", e.id);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  await notify([{
    tenantId: ctx.tenantId,
    employeeId: e.employee_id,
    kind: "device_exception",
    title: "私物パソコンでの業務利用の承認が取り消されました",
    body: "会社貸与パソコンをお使いください。",
    link: "device-consent.html",
    dedupeKey: `device_exception_revoked:${e.id}`,
  }]);

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: "device.exception_revoked", target: e.id,
    detail: { note: body.note || null },
  });
  return json(res, 200, { ok: true });
}

// ---- 小物 -------------------------------------------------------------------
async function employeeMap(sb, tenantId) {
  const { data } = await sb.from("gw_employees")
    .select("id, display_name, department")
    .eq("tenant_id", tenantId).limit(500);
  return new Map((data || []).map((e) => [e.id, {
    id: e.id, name: e.display_name, department: e.department,
  }]));
}
