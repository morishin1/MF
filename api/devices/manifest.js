// GET /api/devices/manifest
//   エージェントが6時間ごとに読む。新しい版があれば自分で入れ替える。
//
// ■ ここが返すのは「言い分」であって、信用の元ではない
//
//   商用のコード署名証明書は使わない方針なので、Windows は
//   落としたEXEが誰の作かを確かめてくれない。
//   そこで、配る版には社内の秘密鍵で署名しておく（agent/cmd/eight-agent-keygen）。
//
//     署名の対象 = version \n url \n sha256 \n size
//
//   エージェントには対になる公開鍵が焼き込んである。
//   署名が合わなければ URL を開きにすらいかない。
//   落としたあとも SHA-256 と大きさを確かめ、合わなければ実行しない。
//
//   4つまとめて署名しているので、「同じハッシュのまま URL だけ差し替える」
//   ということができない。だからここが乗っ取られても、
//   配れるのは秘密鍵で署名した版だけになる。
//
// ■ そろっていないものは配らない
//   版・URL・SHA256・大きさ・署名 の5つがそろっていなければ
//   「更新なし」を返す。確かめられないものを実行させるほうが危ない。
//
// 置き換えるときは Vercel の環境変数だけで切り替えられるようにしてある。
//   DEVICE_AGENT_VERSION / DEVICE_AGENT_URL / DEVICE_AGENT_SHA256
//   DEVICE_AGENT_SIZE / DEVICE_AGENT_SIGNATURE / DEVICE_AGENT_KEY_ID

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { requireDevice } from "../../lib/device-auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const dev = await requireDevice(req, res);
  if (!dev) return;

  // 管理画面（SQL）から登録した版が先。環境変数は、それが無いときの土台
  let row = null;
  try {
    const { data } = await admin().from("gw_device_releases")
      .select("version, url, sha256, size_bytes, signature, key_id")
      .eq("tenant_id", dev.tenant_id).eq("published", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    row = data || null;
  } catch (e) {
    console.error("[devices/manifest]", e?.message || e);
  }

  const version = row?.version || process.env.DEVICE_AGENT_VERSION || null;
  const url = row?.url || process.env.DEVICE_AGENT_URL || null;
  const sha256 = row?.sha256 || process.env.DEVICE_AGENT_SHA256 || null;
  const sizeBytes = Number(row?.size_bytes || process.env.DEVICE_AGENT_SIZE || 0) || 0;
  const signature = row?.signature || process.env.DEVICE_AGENT_SIGNATURE || null;
  const keyId = row?.key_id || process.env.DEVICE_AGENT_KEY_ID || null;

  // 5つそろって、はじめて更新させる。
  // 署名の中身はエージェントが確かめる（ここでは持っていない公開鍵で確かめる）
  const ready = Boolean(version && url && sha256 && sizeBytes > 0 && signature);

  return json(res, 200, {
    update: ready && version !== dev.agent_version,
    version, url, sha256, sizeBytes, signature, keyId,
    recheckSec: 6 * 3600,
  });
}
