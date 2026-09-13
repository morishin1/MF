// POST /api/devices/pair   { token, hostname, os, browsers }   ← インストーラ（認証なし）
//   1回きりの札を預ける。まだ誰のものでもない。
//
// GET  /api/devices/pair?token=…                                ← 本人のブラウザ（要ログイン）
//   その札が何のPCか出す（押す前に見せる画面のため）
//
// POST /api/devices/pair   { token, claim:true, deviceUid }     ← 本人のブラウザ（要ログイン）
//   押した人のものにして、登録コードを1本発行する
//
// GET  /api/devices/pair?token=…&code=1                         ← インストーラ（認証なし）
//   発行された登録コードを1回だけ引き取る
//
// ■ 何を解いているか
//   社員に登録コードを打たせない。
//   インストーラはこのPCの中で札を作り、既定のブラウザで
//   device-setup.html?pair=<札> を開く。ログイン済みの本人が押すと、
//   そこで登録コードが出て、インストーラが引き取って登録を終える。
//   打ち間違いも、コードの配り忘れも起きない。
//
// ■ 札は当てずっぽうでは通らない
//   32バイトの乱数。保存するのはハッシュだけ。
//   使ったら死ぬ。期限は15分。組み立てのあいだしか生きていない。
//
// ■ 押した人が持ち主になる
//   管理者が誰にどのコードを渡したかを管理しなくてよい。
//   ログインしている本人＝そのPCを使う人、として扱う。
//
// ■ ただし、初回は管理者が入れることがある
//   商用のコード署名証明書を使わないので、初回だけ Windows の警告が出る。
//   社員に「警告を無視してよい」と覚えさせないため、
//   最初の1回は管理者か社内IT担当が対象PCで入れる（docs/device-zero-cost.md）。
//   そのとき押すのは管理者なので、**誰のパソコンか選べる**ようにしてある。
//   選べるのは人事権のある人だけ。ほかの人が押せば、これまでどおり自分のものになる。
//
// ■ 引き取りは1回だけ
//   コードは引き取った時点で消す。あとから同じ札で覗かれても何も返らない。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  sha256, newEnrollToken, normalizeBrowsers, browserLabel, BROWSER_KEYS,
} from "../../lib/devices.js";

const SQL = "db/053_devices.sql → 054 → 055 → 057_device_one_pc.sql";
const TTL_MIN = 15;
const str = (v, max = 120) => (v == null ? null : String(v).trim().slice(0, max) || null);

export default async function handler(req, res) {
  if (req.method === "GET") return read(req, res);
  if (req.method === "POST") {
    const body = await readJson(req);
    // claim だけは本人のブラウザから。ほかはインストーラから（認証なし）
    return body?.claim ? claim(req, res, body) : open(res, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- ① インストーラが札を預ける（認証なし） ---------------------------------
async function open(res, body) {
  const token = String(body?.token || "").trim();
  // 短い札は当てられる。インストーラは32バイトの乱数を作る
  if (token.length < 32 || token.length > 200) {
    return json(res, 400, { error: "bad_token" });
  }

  const browsers = normalizeBrowsers(body?.browsers)
    .filter((b) => b.installed).map((b) => b.browser);

  const sb = admin();
  const { error } = await sb.from("gw_device_pairings").insert({
    token_hash: sha256(token),
    hostname: str(body?.hostname, 100),
    os: str(body?.os, 60),
    browsers,
    expires_at: new Date(Date.now() + TTL_MIN * 60000).toISOString(),
  });
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[devices/pair] open", error);
    return json(res, 500, { error: "server_error" });
  }

  // 期限切れの札を片付ける。溜めておく意味が無い
  await sb.from("gw_device_pairings").delete()
    .lt("expires_at", new Date(Date.now() - 86400000).toISOString());

  return json(res, 200, { ok: true, expiresInSec: TTL_MIN * 60 });
}

// ---- ② 本人の画面が中身を見る／④ インストーラがコードを引き取る -------------
async function read(req, res) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const token = String(q.get("token") || "").trim();
  if (!token) return json(res, 400, { error: "bad_token" });

  const sb = admin();
  const { data: p, error } = await sb.from("gw_device_pairings")
    .select("id, tenant_id, employee_id, hostname, os, browsers, used_at, code_once, expires_at")
    .eq("token_hash", sha256(token)).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "server_error" });
  }

  // 「無い」と「期限切れ」を言い分けない
  if (!p || Date.parse(p.expires_at) < Date.now()) {
    return json(res, 404, { error: "expired", message: "この設定用のリンクは使えません" });
  }

  // ---- ④ インストーラが引き取りにきた（認証なし）----
  if (q.get("code") === "1") {
    if (!p.used_at || !p.enrollment_id) return json(res, 200, { ready: false });

    if (!p.code_once) return json(res, 200, { ready: false });

    // 引き取れるのは1回だけ。取った時点でコードを消す。
    // code_once が入っているときだけ通るので、2回目は空振りする。
    //
    // 行そのものは残す。このあとエージェントが登録しにくるとき、
    // 「どのブラウザで押したか」をここから引くため（api/devices/enroll.js）。
    // 期限切れの行は、次に誰かが札を預けたときにまとめて消える
    const { data: got } = await sb.from("gw_device_pairings")
      .update({ code_once: null })
      .eq("id", p.id).not("code_once", "is", null).select("id");
    if (!got?.length) return json(res, 200, { ready: false });

    return json(res, 200, { ready: true, enrollToken: p.code_once });
  }

  // ---- ② 本人の画面。押す前に「何を登録するのか」を見せる ----
  const user = await requireUser(req, res);
  if (!user) return;

  // 管理者が代わりに入れているなら、誰のPCかを選べるようにする。
  // 選べる人だけに名簿を返す（ほかの人には、そもそも出さない）
  const ctx = await gwContext(user.id);
  let members = null;
  if (ctx.tenantId && canManageHr(ctx)) {
    const { data } = await sb.from("gw_employees")
      .select("id, display_name, department")
      // 在籍と、まだログインしていない内定者。
      // 入社日より前にPCを用意することがあるので、invited も出す
      .eq("tenant_id", ctx.tenantId).in("status", ["active", "invited"])
      .order("display_name", { ascending: true }).limit(500);
    members = (data || []).map((e) => ({
      id: e.id, name: e.display_name, department: e.department || "",
    }));
  }

  return json(res, 200, {
    pc: {
      hostname: p.hostname,
      os: p.os,
      browsers: (p.browsers || []).filter((b) => BROWSER_KEYS.includes(b))
        .map((b) => ({ key: b, label: browserLabel(b) })),
    },
    used: Boolean(p.used_at),
    me: ctx.employee ? { id: ctx.employee.id, name: ctx.employee.display_name } : null,
    members,
  });
}

// ---- ③ 本人が押す（要ログイン） ---------------------------------------------
async function claim(req, res, body) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, {
      error: "not_enrolled",
      hint: "社員名簿に登録されていません。管理者に登録を依頼してください",
    });
  }

  const token = String(body?.token || "").trim();
  if (!token) return json(res, 400, { error: "bad_token" });

  const sb = admin();

  // 誰のパソコンにするか。
  // 既定は押した人。人事権のある人だけ、ほかの社員を選べる
  let ownerId = ctx.employee.id;
  let forSomeoneElse = false;
  const picked = str(body?.employeeId, 60);
  if (picked && picked !== ctx.employee.id) {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const { data: emp } = await sb.from("gw_employees")
      .select("id").eq("id", picked).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!emp) return json(res, 400, { error: "bad_employee" });
    ownerId = emp.id;
    forSomeoneElse = true;
  }

  const { data: p } = await sb.from("gw_device_pairings")
    .select("id, hostname, os, browsers, used_at, expires_at")
    .eq("token_hash", sha256(token)).maybeSingle();
  if (!p || Date.parse(p.expires_at) < Date.now()) {
    return json(res, 404, { error: "expired", message: "この設定用のリンクは使えません" });
  }
  if (p.used_at) {
    return json(res, 409, { error: "used", message: "この設定はもう済んでいます" });
  }

  // 登録コードを1本出す。宛先はもう決まっている（押した人）
  const plain = newEnrollToken();
  const { data: enr, error: e1 } = await sb.from("gw_device_enrollments").insert({
    tenant_id: ctx.tenantId,
    employee_id: ownerId,
    token_hash: sha256(plain),
    // 組み立てのあいだしか使わない。長く生かしておく理由がない
    expires_at: new Date(Date.now() + TTL_MIN * 60000).toISOString(),
    created_by: user.id,
  }).select("id").single();
  if (e1) {
    const hint = dbSetupHint(e1, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[devices/pair] enroll", e1);
    return json(res, 500, { error: "server_error" });
  }

  // ブラウザ側の端末（この画面を開いているブラウザ）も覚えておく。
  // エージェントの登録が終わった時点で、同じPCの下に束ねる。
  //
  // ただし管理者がほかの人のPCを設定しているときは、束ねない。
  // いま開いているのは管理者のブラウザなので、束ねると
  // 管理者の使ったブラウザが、その社員の持ち物として台帳に載る
  const deviceUid = forSomeoneElse ? null : str(body?.deviceUid, 100);

  // 札を使い切る。used_at が null のときだけ通るので、
  // 2つのタブから同時に押されても2本目は空振りする
  const { data: used } = await sb.from("gw_device_pairings")
    .update({
      used_at: new Date().toISOString(),
      tenant_id: ctx.tenantId,
      employee_id: ownerId,
      enrollment_id: enr.id,
      device_uid: deviceUid,
      code_once: plain,
    })
    .eq("id", p.id).is("used_at", null).select("id");
  if (!used?.length) {
    await sb.from("gw_device_enrollments").delete().eq("id", enr.id);
    return json(res, 409, { error: "used", message: "この設定はもう済んでいます" });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: "device.pair_claimed", target: enr.id,
    detail: {
      hostname: p.hostname, os: p.os, browsers: p.browsers || [], deviceUid,
      // 誰のPCとして登録したか。管理者が代わりに設定したときに効く
      employeeId: ownerId, onBehalf: forSomeoneElse,
    },
  });

  return json(res, 200, {
    ok: true,
    pc: { hostname: p.hostname, os: p.os },
    // 画面はこのあと「登録が終わるのを待つ」に進む
    waitSec: 60,
  });
}
