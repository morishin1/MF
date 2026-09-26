// GET  /api/guests/accept?token=…            … 招待URLを開いたときの確認（未ログイン）
// POST /api/guests/accept { token, password } … パスワードを決めて登録する（未ログイン）
//
// ■ ログイン前提のAPIではない
//   ここだけは requireUser を呼ばない。招待URLを知っている、という
//   一度きりのトークンそのものが認可（device-pairing と同じ考え方）
//
// ■ 「無い」も「期限切れ」も同じ答え
//   トークンが存在するかどうかを外に漏らさない（api/devices/pair.js と同じ）

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { sha256, TOKEN_RE } from "../../lib/guests.js";

const MIN_PASSWORD = 8;
const NOT_FOUND = { error: "not_found", hint: "この招待URLは使えません（期限切れ・使用済み・取消済みのいずれかです）。管理者にお知らせください。" };

export default async function handler(req, res) {
  if (req.method === "GET") return preview(req, res);
  if (req.method === "POST") return register(req, res);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function findInvite(sb, token) {
  if (!TOKEN_RE.test(String(token || ""))) return null;
  const { data: inv } = await sb.from("gw_guest_invites")
    .select("id, tenant_id, guest_id, expires_at, used_at, revoked_at")
    .eq("token_hash", sha256(token)).maybeSingle();
  if (!inv) return null;
  if (inv.used_at || inv.revoked_at) return null;
  if (new Date(inv.expires_at).getTime() < Date.now()) return null;
  return inv;
}

async function preview(req, res) {
  const token = new URL(req.url, "http://localhost").searchParams.get("token");
  const sb = admin();
  const inv = await findInvite(sb, token);
  if (!inv) return json(res, 404, NOT_FOUND);

  const { data: guest } = await sb.from("gw_guests")
    .select("id, display_name, company_name, email, user_id, disabled_at")
    .eq("id", inv.guest_id).maybeSingle();
  if (!guest || guest.user_id || guest.disabled_at) return json(res, 404, NOT_FOUND);

  const { data: tenant } = await sb.from("tenants").select("name").eq("id", inv.tenant_id).maybeSingle();

  return json(res, 200, {
    displayName: guest.display_name, companyName: guest.company_name,
    email: guest.email, tenantName: tenant?.name || null,
  });
}

async function register(req, res) {
  const body = await readJson(req);
  const password = String(body?.password || "");
  if (password.length < MIN_PASSWORD) {
    return json(res, 400, { error: "weak_password", hint: `パスワードは${MIN_PASSWORD}文字以上にしてください` });
  }

  const sb = admin();
  const inv = await findInvite(sb, body?.token);
  if (!inv) return json(res, 404, NOT_FOUND);

  const { data: guest } = await sb.from("gw_guests")
    .select("id, tenant_id, display_name, email, user_id, disabled_at")
    .eq("id", inv.guest_id).maybeSingle();
  if (!guest || guest.user_id || guest.disabled_at) return json(res, 404, NOT_FOUND);

  // 先にトークンを使用済みにする（早い者勝ち）。同時に2回押されても、
  // 通るのは1回だけ。負けたほうはここで止まる
  const { data: consumed } = await sb.from("gw_guest_invites")
    .update({ used_at: new Date().toISOString() })
    .eq("id", inv.id).is("used_at", null).select("id");
  if (!consumed?.length) return json(res, 409, { error: "used", hint: "この招待はすでに使われています" });

  const { data: created, error: ce } = await sb.auth.admin.createUser({
    email: guest.email, password, email_confirm: true,
    user_metadata: { name: guest.display_name, external: true },
  });
  if (ce) {
    // 巻き戻す。使用済みのままだと、直せる手が管理者の再発行しか無くなる
    await sb.from("gw_guest_invites").update({ used_at: null }).eq("id", inv.id);
    return json(res, 500, { error: "create_user_failed", detail: ce.message });
  }

  const { error: ue } = await sb.from("gw_guests")
    .update({ user_id: created.user.id, updated_at: new Date().toISOString() })
    .eq("id", guest.id);
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  await gwLog({
    tenantId: guest.tenant_id, actorId: created.user.id, action: "guest.register",
    target: `guest:${guest.id}`, detail: { name: guest.display_name, email: guest.email },
  });

  return json(res, 200, { ok: true, email: guest.email });
}
