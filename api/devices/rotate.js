// POST /api/devices/rotate
//   エージェントが90日ごとに、自分のシークレットを取り替える。
//
// 端末のディスクに置いてあるものは、いつか読まれる前提で考える。
// 読まれても、次の入れ替えで使えなくなるようにしておく。
//
// 新しいシークレットを返したあとで端末側の保存に失敗すると、
// その端末は入り直せなくなる。だから返す前に確定はさせず、
// 端末から「保存できた」が来るまで古いほうも通す……までは作り込まない。
// 90日に1度の入れ替えで、失敗したら人が再登録する。
// そのぶん、失敗したことが分かるように agent_error を送らせる。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { requireDevice } from "../../lib/device-auth.js";
import { newSecret, sha256 } from "../../lib/devices.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const dev = await requireDevice(req, res);
  if (!dev) return;

  const secret = newSecret();
  const now = new Date().toISOString();
  const { error } = await admin().from("gw_devices").update({
    secret_hash: sha256(secret), secret_set_at: now, updated_at: now,
  }).eq("id", dev.id);

  if (error) {
    console.error("[devices/rotate]", error);
    return json(res, 500, { error: "server_error" });
  }
  return json(res, 200, { deviceId: dev.id, secret });
}
