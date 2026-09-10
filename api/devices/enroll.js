// POST /api/devices/enroll
//   { enrollToken, deviceUid, hostname, os, osBuild, serial, agentVersion }
//   → { deviceId, secret, linkUrl }
//
// ■ 社員のアカウントをPCに置かない
//   置くと、PCが盗まれた人が社員として全部できてしまう。
//   端末専用の資格情報にして、権限は「自分のぶんを送る」だけにする。
//
// ■ トークンは1回だけ
//   使ったら used_at を入れる。写した紙が残っていても、2台目は登録できない。
//
// ■ 同じPCで入れ直したら、同じ行を使う
//   device_uid はレジストリに残るので、再インストールでも変わらない。
//   新しい行を作ると、台帳に同じPCが2つ並ぶ。
//
// ■ 登録しただけでは、まだ何も送らない
//   本人が linkUrl を開いて告知を読み、「このパソコンです」を押すまで
//   collect:false のまま。エージェントは linkUrl を既定のブラウザで開く。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { newSecret, newLinkCode, sha256, jstDate } from "../../lib/devices.js";

const SQL = "db/054_device_agent.sql";
const str = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const body = await readJson(req);
  const token = String(body.enrollToken || "").trim().toUpperCase();
  const deviceUid = str(body.deviceUid, 100);
  const hostname = str(body.hostname, 100);
  if (!token || !deviceUid || !hostname) {
    return json(res, 400, { error: "bad_request", message: "登録コードと端末情報が要ります" });
  }

  const sb = admin();

  const { data: enr, error } = await sb
    .from("gw_device_enrollments")
    .select("id, tenant_id, employee_id, expires_at, used_at, created_by")
    .eq("token_hash", sha256(token))
    .maybeSingle();

  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[devices/enroll]", error);
    return json(res, 500, { error: "server_error" });
  }

  // 「無い」「使用済み」「期限切れ」を言い分けない。
  // 総当たりする側に手がかりを渡さないため
  const dead = !enr || enr.used_at || Date.parse(enr.expires_at) < Date.now();
  if (dead) {
    return json(res, 400, { error: "invalid_token", message: "この登録コードは使えません" });
  }

  // 同じPCが既に台帳にいるか。device_uid はレジストリに残るので、
  // 入れ直しても変わらない
  const { data: exist } = await sb
    .from("gw_devices")
    .select("id, tenant_id, employee_id, notified_at, source")
    .eq("device_uid", deviceUid)
    .maybeSingle();

  // 他社の端末を、こちらのコードで乗っ取れないようにする。
  // ブラウザの行と device_uid がぶつかることも無いはずだが、念のため見る
  if (exist && (exist.tenant_id !== enr.tenant_id || exist.source !== "agent")) {
    return json(res, 400, { error: "invalid_token", message: "この登録コードは使えません" });
  }

  const secret = newSecret();
  const linkCode = newLinkCode();
  const now = new Date().toISOString();
  const fields = {
    hostname,
    label: hostname,
    os: str(body.os, 60) || "Windows",
    os_version: str(body.osVersion, 40),
    os_build: str(body.osBuild, 40),
    serial: str(body.serial, 120),
    agent_version: str(body.agentVersion, 40),
    secret_hash: sha256(secret),
    secret_set_at: now,
    link_code_hash: sha256(linkCode),
    // 本人が開くまでの猶予。長く生かしておく理由がない
    link_expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    updated_at: now,
  };

  let dev;
  if (exist) {
    // 入れ直しただけ。本人の承認も、割り当て済みの使う人も消さない。
    // コードに使う人が指定されていて、まだ空のときだけ埋める
    const patch = { ...fields, status: exist.notified_at ? "active" : "unconfirmed" };
    if (enr.employee_id && !exist.employee_id) patch.employee_id = enr.employee_id;
    const { data, error: e2 } = await sb
      .from("gw_devices").update(patch).eq("id", exist.id)
      .select("id, notified_at").single();
    if (e2) {
      console.error("[devices/enroll] update", e2);
      return json(res, 500, { error: "server_error" });
    }
    dev = data;
  } else {
    const { data, error: e2 } = await sb
      .from("gw_devices")
      .insert({
        ...fields,
        tenant_id: enr.tenant_id, device_uid: deviceUid, source: "agent",
        employee_id: enr.employee_id, enrolled_by: enr.created_by,
        enrolled_at: now, first_seen_at: now, status: "unconfirmed",
      })
      .select("id, notified_at").single();
    if (e2) {
      console.error("[devices/enroll] insert", e2);
      return json(res, 500, { error: "server_error" });
    }
    dev = data;

    await sb.from("gw_device_events").insert({
      tenant_id: enr.tenant_id, device_id: dev.id,
      work_date: jstDate(), at: now, kind: "agent_start",
      detail: { name: hostname, version: fields.agent_version },
    });
  }

  await sb.from("gw_device_enrollments")
    .update({ used_at: now, used_by: dev.id })
    .eq("id", enr.id)
    .is("used_at", null);

  // エージェントはこのURLを既定のブラウザで開く。
  // 本人がログインした状態で開けば、そのブラウザとこのPCがつながる
  const base = (process.env.PUBLIC_BASE_URL || "https://mf.8grp.co.jp").replace(/\/$/, "");

  return json(res, 200, {
    deviceId: dev.id,
    secret,
    // 本人が告知を読むまで、エージェントは何も送らない
    collect: Boolean(dev.notified_at),
    linkUrl: `${base}/device-consent.html?link=${encodeURIComponent(linkCode)}`,
  });
}
