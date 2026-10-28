// Existing authenticated owner UI only. Never accept a cron secret or caller-selected data/recipient.
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { requireUser } from "../../lib/auth.js";
import { SOURCE, snapshotConfig, deliverSnapshot } from "../../lib/gw-owner-snapshot.js";

export function sameOriginJson(req) {
  return req.headers.origin === SOURCE
    && (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin")
    && /^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")
    && /^Bearer [^\s]+$/.test(req.headers.authorization || "");
}

export async function handleManualSnapshot(req, res, {
  authenticate = requireUser, sbFactory = admin, deliver = deliverSnapshot,
  env = process.env, now = new Date(),
} = {}) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  // JSON + explicit Bearer + exact trusted Origin (not Host/X-Forwarded-Host) protects against CSRF.
  if (!sameOriginJson(req)) return json(res, 403, { error: "same_origin_required", hint: "GWの日報管理画面から操作してください。" });
  if ([...new URL(req.url, SOURCE).searchParams].length) return json(res, 400, { error: "fixed_scope_only" });
  const body = await readJson(req);
  if (!body || Array.isArray(body) || Object.keys(body).length) return json(res, 400, { error: "fixed_scope_only" });
  const user = await authenticate(req, res);
  if (!user) return;
  const cfg = snapshotConfig(env, now);
  if (!cfg.ok) return json(res, 503, { error: cfg.reason, hint: "初期設定がまだ完了していません。SQL・固定設定の確認後に使えます。", sendAttempted: false });
  try {
    const sb = sbFactory();
    const actor = await sb.from("gw_employees").select("id,user_id,tenant_id")
      .eq("tenant_id", cfg.tenantId).eq("id", cfg.ownerId).maybeSingle();
    if (actor.error) return json(res, 503, { error: "actor_status_unavailable", sendAttempted: false });
    if (!actor.data || actor.data.user_id !== user.id)
      return json(res, 403, { error: "owner_actor_mismatch", hint: "この操作は設定済みの代表本人だけが使えます。", sendAttempted: false });
    // deliver rechecks the owner's current grant/membership/status/address before any payload read/send.
    const result = await deliver({ sb, cfg, now, slot: "manual", env, actorUserId: user.id });
    if (result.status === "unknown") return json(res, 502, { ...result, error: "dispatch_result_unknown",
      hint: "送信結果を確認できません。同じ版は自動再送しません。代表メールの受信状況を確認してください。" });
    if (result.status === "not_sent") return json(res, 503, { ...result, error: "send_not_started", hint: "送信を開始できませんでした。設定を確認してください。" });
    return json(res, 200, result); // counts/status only; never private snapshot content.
  } catch (e) {
    const denied = ["owner_inactive", "owner_forbidden", "recipient_binding_mismatch"].includes(e?.message);
    return json(res, denied ? 403 : 503, { error: denied ? "owner_not_authorized" : "snapshot_unavailable",
      hint: denied ? "代表本人の現在の権限・在籍・宛先を確認できません。" : "日報または送信台帳を確認できません。未提出とは判断せず、設定を確認してください。",
      sendAttempted: false });
  }
}
export default function handler(req, res) { return handleManualSnapshot(req, res); }
