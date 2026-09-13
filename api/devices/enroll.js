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
import { gwLog } from "../../lib/gw-audit.js";
import {
  newSecret, newLinkCode, sha256, jstDate, normalizeBrowsers,
} from "../../lib/devices.js";

// 053 → 054 → 055 → 057 の順で流す。列が足りないときも同じ案内を出す
const SQL = "db/053_devices.sql → 054_device_agent.sql → 055_device_admin.sql → 057_device_one_pc.sql";
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
    .select("id, tenant_id, employee_id, expires_at, used_at, revoked_at, created_by, created_at")
    .eq("token_hash", sha256(token))
    .maybeSingle();

  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[devices/enroll]", error);
    return json(res, 500, { error: "server_error" });
  }

  // 「無い」「使用済み」「期限切れ」「取り消し済み」を言い分けない。
  // 総当たりする側に手がかりを渡さないため
  const dead = !enr || enr.used_at || enr.revoked_at
    || Date.parse(enr.expires_at) < Date.now();
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

  // ---- そのPCのブラウザと、そのPCで社内システムを開いていたブラウザの行 ----
  //
  // ここで束ねておかないと、台帳に「エージェントの行」と「ブラウザの行」が
  // 2つ並ぶ。人から見れば1台なので、登録が終わった時点で1行にする
  await linkBrowsers(sb, enr, dev, body);

  // コードを使い切る。used_at が null のときだけ通るので、
  // 同時に2台から来ても2台目は空振りする
  const { data: consumed } = await sb.from("gw_device_enrollments")
    .update({ used_at: now, used_by: dev.id })
    .eq("id", enr.id)
    .is("used_at", null)
    .select("id");

  // いつ・どの端末に使われたか。発行のログと対で見る。
  // ここは端末から呼ばれる口なので、actorId は無い（人ではない）
  if (consumed?.length) {
    await gwLog({
      tenantId: enr.tenant_id, actorId: null,
      action: "device.token_used", target: enr.id,
      detail: {
        deviceId: dev.id,
        hostname,
        issuedBy: enr.created_by,
        issuedAt: enr.created_at,
        expiresAt: enr.expires_at,
      },
    });
  }

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

/**
 * 1台のPCを1行にする。
 *
 *  ① インストーラが見つけたブラウザを、そのPCの下に並べる
 *  ② 組み立てのときに本人が開いていたブラウザの行を、そのPCに束ねる
 *
 * ここが落ちても登録は成功にする。台帳に載ることのほうが大事で、
 * 束ね直しは管理画面からでもできる
 */
async function linkBrowsers(sb, enr, dev, body) {
  try {
    // ① 入っているブラウザ
    const list = normalizeBrowsers(body.browsers);
    if (list.length) {
      await sb.from("gw_device_browsers").upsert(
        list.map((b) => ({
          tenant_id: enr.tenant_id, device_id: dev.id,
          browser: b.browser, installed: b.installed, linked: b.linked,
          ext_version: b.extVersion, updated_at: new Date().toISOString(),
        })),
        { onConflict: "device_id,browser" },
      );
    }

    // ② 本人が「このパソコンです」を押したブラウザ。
    //    どのブラウザで押したかは、組み立てのときの札に控えてある。
    //    エージェントは知らないので、こちらで引く
    const { data: pair } = await sb.from("gw_device_pairings")
      .select("device_uid").eq("enrollment_id", enr.id).maybeSingle();
    const deviceUid = str(pair?.device_uid, 100);
    if (!deviceUid) return;

    const { data: row } = await sb.from("gw_devices")
      .select("id, tenant_id, source, linked_device_id")
      .eq("device_uid", deviceUid).eq("tenant_id", enr.tenant_id).maybeSingle();
    // 他社の行や、別のエージェントの行は動かさない
    if (!row || row.source !== "browser" || row.linked_device_id) return;

    await sb.from("gw_devices").update({
      linked_device_id: dev.id,
      employee_id: enr.employee_id || undefined,
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);

    await sb.from("gw_device_events").insert({
      tenant_id: enr.tenant_id, device_id: row.id,
      work_date: jstDate(), at: new Date().toISOString(), kind: "linked",
      detail: { to: dev.id, by: "installer" },
    });
  } catch (e) {
    console.error("[devices/enroll] ブラウザを束ねられませんでした:", e?.message || e);
  }
}
