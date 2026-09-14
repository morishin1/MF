// ブラウザ拡張の受け入れ口。
//
//   POST /api/devices/browser {action:"code"}                … 画面から。合言葉をもらう
//   POST /api/devices/browser {action:"pair", code, browser} … 拡張から。資格情報に換える
//
// ■ なぜ要るのか
//
//   拡張は、これまで自分ではサーバにつながらなかった。
//   数えた結果をパソコンの中のソフト（EIGHT Agent の EXE）へ渡し、
//   そのソフトがサーバへ送っていた。
//
//   つまり「拡張を入れるだけ」では何も動かず、
//   EXE を配って、SmartScreen をくぐって、入れてもらう必要があった。
//   入れ直し・更新のたびに同じことをやる。そこが重い。
//
//   これからは、拡張が自分でサーバへ送る。
//   社員がすることは「グループウェアにログインする」「拡張を入れる」の2つだけ。
//
// ■ 鍵の渡し方
//
//   拡張は、社員のログイン（Supabase のトークン）を読めない。別のオリジンなので、
//   localStorage も Cookie も見えない。読めてしまうほうが困る。
//
//   そこで、
//     1. ログイン済みの画面が、この口から **1回きりの合言葉** をもらう
//     2. 画面が、その合言葉を拡張へ渡す（chrome.runtime.sendMessage）
//     3. 拡張が、この口で合言葉を **端末専用の資格情報** に換える
//
//   合言葉は5分で切れ、1回使うと死ぬ。
//   拡張が持つのは端末専用の資格情報だけで、できることは
//   「自分のぶんを送る」しかない。社員としては何もできない。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { jstDate, cleanUid, newSecret, newLinkCode, sha256, browserLabel } from "../../lib/devices.js";

const SQL = "db/053_devices.sql → 054_device_agent.sql → 067_browser_first.sql";

// 合言葉の寿命。画面から拡張へ渡すだけなので、長くする理由がない
const CODE_MIN = 5;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJson(req);
  const action = String(body?.action || "");

  // 拡張から来るほう。ログインは見ない（拡張は社員の鍵を持たない）
  if (action === "pair") return pair(res, body);

  // 画面から来るほう。ログインしている本人だけ
  if (action === "code") return issue(req, res, body);

  return json(res, 400, { error: "bad_action" });
}

// ---- 1) 画面が、合言葉をもらう -------------------------------------------------
async function issue(req, res, body) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, {
      error: "no_employee",
      hint: "社員名簿にあなたの行がありません。管理者に登録を依頼してください。",
    });
  }

  const uid = cleanUid(body?.deviceUid);
  if (!uid) return json(res, 400, { error: "bad_request" });

  const sb = admin();

  // このブラウザの行。合図（deviceBeat）で先にできている
  const { data: dev, error } = await sb.from("gw_devices")
    .select("id, tenant_id, employee_id, source, label, notified_at")
    .eq("device_uid", uid).eq("tenant_id", ctx.tenantId).limit(1).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  // 自分の端末にしか渡さない
  if (!dev || dev.employee_id !== ctx.employee.id) {
    return json(res, 404, { error: "not_found", hint: "この端末の登録がまだです。画面を開き直してください" });
  }

  const code = newLinkCode();
  const expires = new Date(Date.now() + CODE_MIN * 60000).toISOString();
  const { error: ue } = await sb.from("gw_devices").update({
    link_code_hash: sha256(code),
    link_expires_at: expires,
    updated_at: new Date().toISOString(),
  }).eq("id", dev.id);
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  return json(res, 200, { code, expiresAt: expires, deviceId: dev.id });
}

// ---- 2) 拡張が、資格情報に換える -----------------------------------------------
async function pair(res, body) {
  const code = String(body?.code || "").trim();
  if (!code) return json(res, 400, { error: "bad_request" });

  const sb = admin();
  const { data: dev, error } = await sb.from("gw_devices")
    .select("id, tenant_id, employee_id, source, status, notified_at, link_expires_at")
    .eq("link_code_hash", sha256(code)).limit(1).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  // 「無い」と「期限切れ」を言い分けない。総当たりの手がかりを渡さない
  const dead = !dev
    || (dev.link_expires_at && Date.parse(dev.link_expires_at) < Date.now());
  if (dead) {
    return json(res, 400, {
      error: "invalid_code",
      message: "この合言葉は使えません。グループウェアの画面を開き直してください",
    });
  }

  // 端末専用の資格情報。できることは「自分のぶんを送る」だけ
  const secret = newSecret();
  const now = new Date().toISOString();
  const browser = String(body?.browser || "").toLowerCase().slice(0, 20) || null;

  const { error: ue } = await sb.from("gw_devices").update({
    secret_hash: sha256(secret),
    // 合言葉は使い切る
    link_code_hash: null,
    link_expires_at: null,
    // 拡張の版は gw_device_browsers が持つ。台帳の行に二重に置かない
    installed_at: now,
    updated_at: now,
  }).eq("id", dev.id);
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  // どのブラウザで、いつつながったか。管理画面の「ブラウザ連携」のもと
  if (browser) {
    await sb.from("gw_device_browsers").upsert({
      tenant_id: dev.tenant_id, device_id: dev.id, browser,
      installed: true, linked: true,
      ext_version: String(body?.version || "").slice(0, 20) || null,
      last_seen_at: now, updated_at: now,
    }, { onConflict: "device_id,browser" });
  }

  await sb.from("gw_device_events").insert({
    tenant_id: dev.tenant_id, device_id: dev.id,
    work_date: jstDate(), at: now, kind: "linked",
    detail: browser ? { name: browserLabel(browser) } : {},
  });

  return json(res, 200, {
    deviceId: dev.id,
    secret,
    // 本人が「記録すること」を読むまでは、送っても受け取らない。
    // 拡張には、そのことを先に伝えておく（黙って捨てられると、
    // 拡張のログを読む人が「壊れている」と思う）
    collect: Boolean(dev.notified_at),
    consentUrl: dev.notified_at ? null : "device-consent.html",
  });
}
