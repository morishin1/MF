// POST /api/devices/wiped
//   そのPCのエージェントが「自分を消し終わった」と報せてくる口。
//
// ■ ここが呼ばれるまで、台帳には「削除待ち」と出る
//
//   管理者が「端末を削除」を押した時点でできるのは、
//   資格情報を失効させることと、命令を置いておくことだけ。
//   PCがオフラインなら、何も起きない。
//   実際に消えたかどうかは、そのPCから報せが来てはじめて分かる。
//
//   だから「削除しました」とは書かない。
//   消えるまでは「削除待ち」と出して、押した人に待ちを見せる。
//
// ■ 報せが届いた時点で、資格情報を本当に殺す
//
//   失効（revoked_at）のあいだ、その資格情報に残っている力は
//   「消せという命令を受け取る」「消し終わったと報せる」の2つだけ。
//   報せが届けば、その2つも要らない。secret_hash を落とす。
//
// ■ 過去の記録は消さない
//
//   消えるのは台帳に並ぶ1行と、そのPCの中のエージェント。
//   監査記録・WEB利用・セキュリティのできごとは、そのまま残す。
//   保存期間が来たら、いつもの掃除（db/059）で消える。
//   ここで一緒に消すと、「辞める前に消しておけば残らない」が成り立つ。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { requireDevice } from "../../lib/device-auth.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate } from "../../lib/devices.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  // 失効した端末しか、ここへは来ない。allowRevoked を渡さないと
  // 自分が消えたことを報せられなくなる
  const dev = await requireDevice(req, res, { allowRevoked: true });
  if (!dev) return;

  // 消せと言われていないのに消えたと言ってくる。受け取らない。
  // 台帳の行を、端末側の言い分だけで消させない
  if (!dev.wipe_requested_at) {
    return json(res, 409, {
      error: "not_requested",
      message: "この端末に削除の指示は出ていません",
    });
  }

  const sb = admin();
  const now = new Date().toISOString();

  // 2回目以降は、何もせず同じ返事をする。
  // 報せたあとで電源が落ちると、次の起動でもう一度来ることがある
  if (dev.wipe_done_at) return json(res, 200, { ok: true, already: true });

  const body = await readJson(req).catch(() => ({}));
  // 外せなかったものがあれば書いてくる。長さは切る
  const note = String(body?.note || "").trim().slice(0, 500) || null;
  const left = Array.isArray(body?.left)
    ? body.left.map((s) => String(s).slice(0, 60)).slice(0, 20) : [];

  const { error } = await sb.from("gw_devices").update({
    wipe_done_at: now,
    wipe_note: note,
    deleted_at: now,
    status: "retired",
    retired_at: dev.retired_at || now,
    // ここで本当に殺す。以後この資格情報は何もできない
    secret_hash: null,
    updated_at: now,
  }).eq("id", dev.id);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  // 端末の履歴にも残す。「いつ消えたか」を、その端末から辿れるように
  await sb.from("gw_device_events").insert({
    tenant_id: dev.tenant_id, device_id: dev.id,
    work_date: jstDate(), at: now, kind: "wiped",
    detail: left.length ? { left: left.join(" / ") } : {},
  });

  // 監査には、消し終わったことを別に残す。
  // 指示したときの1行（device.wipe）と対になる
  await gwLog({
    tenantId: dev.tenant_id, actorId: null,
    action: "device.wipe_done", target: dev.id,
    detail: { hostname: dev.hostname || dev.label, note, left },
  });

  return json(res, 200, { ok: true });
}
