// エージェントの資格情報を確かめる。
//
//   Authorization: Device <deviceId>:<secret>
//
// 社員の JWT は使わない。端末に置くのは端末専用の資格情報で、
// できることは「自分のぶんを送る」だけ。
//
// 平文のシークレットは保存していないので、突き合わせは sha256 でやる。

import { json } from "./http.js";
import { admin } from "./supabase.js";
import { readDeviceAuth, sha256 } from "./devices.js";

const FIELDS = "id, tenant_id, employee_id, device_uid, hostname, label, source, status, "
  + "notified_at, secret_hash, agent_version, last_seen_at";

/**
 * 端末を解決する。失敗時は 401/403 を書き込んで null を返す。
 * @returns {Promise<object|null>} gw_devices の行
 */
export async function requireDevice(req, res) {
  const auth = readDeviceAuth(req.headers["authorization"] || req.headers["Authorization"]);
  if (!auth) {
    json(res, 401, { error: "unauthorized" });
    return null;
  }

  const { data: dev } = await admin()
    .from("gw_devices").select(FIELDS).eq("id", auth.deviceId).maybeSingle();

  // 端末が無いのと、シークレットが違うのを言い分けない。
  // source='browser' の行はシークレットを持たないので、ここでは通らない
  if (!dev || dev.source !== "agent" || !dev.secret_hash
      || dev.secret_hash !== sha256(auth.secret)) {
    json(res, 401, { error: "unauthorized" });
    return null;
  }
  // 使用終了にした端末は、まだ動いていても受け取らない。
  // 返却済みのPCから記録が届き続けるほうが困る
  if (dev.status === "retired") {
    json(res, 403, { error: "retired", message: "この端末は使用終了になっています" });
    return null;
  }
  return dev;
}
