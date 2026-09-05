// GET    /api/blocks            … 止めているサイトの一覧と、止めた記録
// POST   /api/blocks {domain, serviceName, note}
// PATCH  /api/blocks {id, enabled, serviceName, note}
// DELETE /api/blocks?id=…
//
// 8grp.co.jp に口コミサイトから来たアクセスを止める仕組みの、台帳の管理画面。
// 判定そのものは 8grp.co.jp 側の Apache（.htaccess）が持っていて、
// ここで足したドメインは、毎時の GitHub Actions が .htaccess に焼き込む。
// つまり ON / OFF はすぐには効かない（最大1時間）。画面にもそう書いてある。
//
// 以前は事務ポータル（8grp.co.jp/8/zimu/block/）にあった画面をこちらへ移した。
//
// 読み取りは RLS（db/023）が「管理者・経営者だけ」に絞る。
// 書き込みは service_role で行い、この口だけを唯一の入口にする。
// 台帳を直接書ける口をブラウザに残すと、壊されたときに誰がやったか追えないため。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const canManage = (ctx) => ctx.isAdmin || ctx.roles.includes("owner");

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManage(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res);
  if (req.method === "POST") return create(req, res, ctx, user);
  if (req.method === "PATCH") return update(req, res, ctx, user);
  if (req.method === "DELETE") return remove(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res) {
  const sb = userClient(req);

  const { data: referrers, error } = await sb
    .from("blocked_referrers")
    .select("id, domain, service_name, enabled, note, created_at")
    .order("domain")
    .limit(300);
  if (error) {
    // まだ 021/023 を流していない環境では、画面を落とさず案内だけ返す
    return json(res, 200, {
      referrers: [], logs: [], byDomain: [], stats: { today: 0, week: 0, month: 0 },
      setupNeeded: true, detail: error.message,
    });
  }

  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: logs } = await sb
    .from("blocked_access_logs")
    .select("id, created_at, domain, path, referer, user_agent")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);

  // 参照元ごとの件数は、100件の表示ぶんではなく30日ぶん全部から数える
  const { data: all } = await sb
    .from("blocked_access_logs")
    .select("domain, created_at")
    .gte("created_at", since)
    .limit(20000);

  const rows = all || [];
  const midnight = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const week = new Date(Date.now() - 7 * 86400000).toISOString();

  const counts = new Map();
  for (const r of rows) counts.set(r.domain || "(不明)", (counts.get(r.domain || "(不明)") || 0) + 1);

  return json(res, 200, {
    referrers: referrers || [],
    logs: logs || [],
    byDomain: [...counts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count),
    stats: {
      today: rows.filter((r) => r.created_at >= midnight).length,
      week: rows.filter((r) => r.created_at >= week).length,
      month: rows.length,
    },
  });
}

// ---- 追加・更新・削除 -------------------------------------------------------
async function create(req, res, ctx, user) {
  const body = await readJson(req);
  const domain = normalizeDomain(body?.domain);
  if (!domain) {
    return json(res, 400, {
      error: "invalid_domain",
      hint: "ドメインだけを入れてください（例: openwork.jp）。https:// や / は要りません",
    });
  }
  const serviceName = String(body?.serviceName ?? "").trim() || domain;

  const { data, error } = await admin()
    .from("blocked_referrers")
    .insert({
      domain,
      service_name: serviceName.slice(0, 100),
      note: String(body?.note ?? "").trim().slice(0, 500) || null,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") return json(res, 409, { error: "already_exists", hint: `${domain} は登録済みです` });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "block.add",
    target: `referrer:${domain}`, detail: { service_name: serviceName },
  });
  return json(res, 200, { referrer: data });
}

async function update(req, res, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const patch = {};
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.serviceName !== undefined) patch.service_name = String(body.serviceName).trim().slice(0, 100) || null;
  if (body.note !== undefined) patch.note = String(body.note).trim().slice(0, 500) || null;
  if (!Object.keys(patch).length) return json(res, 400, { error: "nothing_to_update" });

  const { data, error } = await admin()
    .from("blocked_referrers").update(patch).eq("id", body.id).select("*").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "referrer_not_found" });

  if (patch.enabled !== undefined) {
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id,
      action: patch.enabled ? "block.enable" : "block.disable",
      target: `referrer:${data.domain}`, detail: { service_name: data.service_name },
    });
  }
  return json(res, 200, { referrer: data });
}

async function remove(req, res, ctx, user) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { data, error } = await admin()
    .from("blocked_referrers").delete().eq("id", id).select("domain").maybeSingle();
  if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "referrer_not_found" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "block.remove",
    target: `referrer:${data.domain}`, detail: {},
  });
  return json(res, 200, { ok: true, id });
}

// ---- 補助 -------------------------------------------------------------------
// 手入力の揺れ（"https://openwork.jp/" など）をここで吸収する。
// 変な値がそのまま .htaccess の正規表現へ入ると、8grp.co.jp が 500 になる。
function normalizeDomain(raw) {
  const s = String(raw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split(":")[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}
