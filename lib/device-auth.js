// エージェントの資格情報を確かめる。
//
//   Authorization: Device <deviceId>:<secret>
//
// 社員の JWT は使わない。端末に置くのは端末専用の資格情報で、
// できることは「自分のぶんを送る」だけ。
//
// 平文のシークレットは保存していないので、突き合わせは sha256 でやる。
//
// ■ 失効（revoked_at）の扱い
//
//   紛失・削除のときに資格情報を失効させる。ただし、そこで完全に殺すと
//   「次の通信でそのPCからエージェントを消す」ができなくなる。
//   消せという命令を受け取る口が、資格情報を要るからである。
//
//   そこで失効とは「記録をもう受け取らない」こととして扱う。
//   残るのは、自分が消えるための2つだけ。
//
//     GET  /api/devices/config  … 消せという命令を受け取る
//     POST /api/devices/wiped   … 消し終わったと報せる
//
//   この2つだけが allowRevoked を渡す。ほかは 403 で落とす。
//   消し終わった報せが届いた時点で secret_hash を落とすので、
//   そこではじめて、その資格情報は何もできなくなる。

import { json } from "./http.js";
import { admin } from "./supabase.js";
import { readDeviceAuth, sha256 } from "./devices.js";

const FIELDS = "id, tenant_id, employee_id, device_uid, hostname, label, source, status, "
  + "notified_at, secret_hash, agent_version, last_seen_at, retired_at";

// 064 をまだ流していない環境では、この列が無い。
// 無い列を SELECT すると、そのリクエストごと落ちる（＝全台が止まる）ので、
// 別に取って、落ちたら「失効していない」として扱う
const LIFE = "revoked_at, wipe_requested_at, wipe_done_at, deleted_at";

/**
 * 端末を解決する。失敗時は 401/403 を書き込んで null を返す。
 *
 * @param {object} opts
 * @param {boolean} [opts.allowRevoked] 失効した端末も通す（config / wiped だけ）
 * @returns {Promise<object|null>} gw_devices の行。
 *   64 が流れていれば revoked_at / wipe_requested_at / wipe_done_at も入る
 */
export async function requireDevice(req, res, opts = {}) {
  // どの種類の端末を通すか。
  //
  //   agent   … PCに入れた常駐ソフト（EXE）
  //   browser … Chrome / Edge の拡張
  //
  // 既定は agent だけ。EXE のための口（更新の確認・シークレットの入れ替え）に
  // 拡張が入ってこないようにする。記録を送る口（ingest）だけが両方を通す
  const sources = opts.sources || ["agent"];
  const auth = readDeviceAuth(req.headers["authorization"] || req.headers["Authorization"]);
  if (!auth) {
    json(res, 401, { error: "unauthorized" });
    return null;
  }

  const sb = admin();
  const { data: dev } = await sb
    .from("gw_devices").select(FIELDS).eq("id", auth.deviceId).maybeSingle();

  // 端末が無いのと、シークレットが違うのを言い分けない。
  // シークレットを持たない行（拡張をつないでいないブラウザ）は、
  // ここで必ず落ちる
  if (!dev || !sources.includes(dev.source) || !dev.secret_hash
      || dev.secret_hash !== sha256(auth.secret)) {
    json(res, 401, { error: "unauthorized" });
    return null;
  }

  // 一生ぶんの列。064 が無くても落とさない
  try {
    const { data: life, error } = await sb
      .from("gw_devices").select(LIFE).eq("id", dev.id).maybeSingle();
    if (!error && life) Object.assign(dev, life);
  } catch (e) { /* 064 がまだ */ }

  // 使用終了にした端末は、まだ動いていても受け取らない。
  // 返却済みのPCから記録が届き続けるほうが困る。
  //
  // ただし削除を指示してあるなら、消せという命令を渡すほうが先。
  // 「使用終了にしてから削除する」が普通の順番なので、
  // ここで先に落とすと、いつまでも消えないPCができる
  const wiping = Boolean(dev.wipe_requested_at) && !dev.wipe_done_at;
  if (dev.status === "retired" && !(opts.allowRevoked && wiping)) {
    json(res, 403, { error: "retired", message: "この端末は使用終了になっています" });
    return null;
  }

  if (dev.revoked_at && !opts.allowRevoked) {
    json(res, 403, {
      error: "revoked",
      message: "この端末の資格情報は失効しています",
      // エージェントが「ただ切られた」のか「消せと言われている」のかを
      // 見分けられるように。くわしくは config で受け取る
      uninstall: wiping,
    });
    return null;
  }
  return dev;
}
