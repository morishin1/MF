// GET /api/devices/manifest
//   エージェントが6時間ごとに読む。新しい版があれば自分で入れ替える。
//
// ■ ここが返すのは「言い分」であって、信用の元ではない
//
//   商用のコード署名証明書は使わない方針なので、Windows は
//   落としたEXEが誰の作かを確かめてくれない。
//   そこで、配る版には社内の秘密鍵で署名しておく（agent/cmd/eight-agent-keygen）。
//
//     署名の対象 = version \n 置き場所 \n sha256 \n size
//
//   置き場所は、非公開バケットの中のパス。
//   落とすURLはそのつど短時間だけ作るので毎回変わる。
//   変わるものに署名しても合わないので、変わらないほうに署名する。
//
//   エージェントには対になる公開鍵が焼き込んである。
//   署名が合わなければ URL を開きにすらいかない。
//   落としたあとも SHA-256 と大きさを確かめ、合わなければ実行しない。
//
//   4つまとめて署名しているので、「同じハッシュのまま置き場所だけ差し替える」
//   ということができない。だからここが乗っ取られても、
//   配れるのは秘密鍵で署名した版だけになる。
//   落とすURLは署名の対象ではないが、すり替えは SHA-256 で止まる。
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
      .select("version, url, bucket, object_path, sha256, size_bytes, signature, key_id")
      .eq("tenant_id", dev.tenant_id).eq("published", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    row = data || null;
  } catch (e) {
    console.error("[devices/manifest]", e?.message || e);
  }

  const version = row?.version || process.env.DEVICE_AGENT_VERSION || null;
  const sha256 = row?.sha256 || process.env.DEVICE_AGENT_SHA256 || null;
  const sizeBytes = Number(row?.size_bytes || process.env.DEVICE_AGENT_SIZE || 0) || 0;
  const signature = row?.signature || process.env.DEVICE_AGENT_SIGNATURE || null;
  const keyId = row?.key_id || process.env.DEVICE_AGENT_KEY_ID || null;

  const bucket = row?.bucket || process.env.DEVICE_AGENT_BUCKET || "agent";
  const objectPath = row?.object_path || process.env.DEVICE_AGENT_OBJECT || null;
  const plainUrl = row?.url || process.env.DEVICE_AGENT_URL || null;

  // 署名されているのは置き場所。落とすURLはこれから作る
  const locator = objectPath || plainUrl || null;

  // 5つそろって、はじめて更新させる。
  // 署名の中身はエージェントが確かめる（ここでは持っていない公開鍵で確かめる）
  const ready = Boolean(version && locator && sha256 && sizeBytes > 0 && signature);
  const update = ready && version !== dev.agent_version;

  // 上げる版が無いなら、URLを作りにいかない。
  // 短命のURLを、使わないのに毎回作る理由がない
  let url = null;
  if (update) {
    url = objectPath
      ? await signedUrl(bucket, objectPath)
      : plainUrl;
  }

  return json(res, 200, {
    // URLを作れなければ、この回は更新させない。次の回に持ち越す
    update: update && Boolean(url),
    version, url, locator, sha256, sizeBytes, signature, keyId,
    recheckSec: 6 * 3600,
  });
}

/**
 * 非公開の置き場から、短時間だけ落とせるURLを作る。
 *
 * 長く生きるURLを表に持たない、という方針の片割れ。
 * 更新は落として終わりなので、10分あれば足りる
 */
async function signedUrl(bucket, objectPath) {
  try {
    const { data, error } = await admin().storage.from(bucket)
      .createSignedUrl(objectPath, 600);
    if (error) throw error;
    return data?.signedUrl || null;
  } catch (e) {
    console.error("[devices/manifest] 署名つきURLを作れません:", e?.message || e);
    return null;
  }
}
