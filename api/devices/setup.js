// POST /api/devices/setup            … 本人が、自分のための1回きりの札を作る
// GET  /api/devices/setup?token=…    … その札がどこまで進んだかを見る（画面が待つのに使う）
// GET  /api/devices/setup?download=… … 札を確かめて、インストーラの置き場へ送る
//
// ■ なぜ管理者が配る登録コードをやめたのか
//
//   社員はグループウェアにログインしている。誰なのかはもう分かっている。
//   それなのにコードを配って打たせるのは、配る手間と打ち間違いを
//   足しているだけで、確かめられることは増えていない。
//
//   ログイン中の本人が札を作れば、その札は最初から「その人のもの」になる。
//   あとから社員名を選ぶ場面も、コードを打つ場面も無くなる。
//
// ■ 札の届け方
//
//   落とすファイルの名前に入れる。
//
//     EIGHT-Agent-Setup-<札>.exe
//
//   インストーラは自分のファイル名から読む。打ち込ませない。
//   中身は変えないので、署名もハッシュもそのまま通る。
//
//   名前を変えられて読めなかったときは、これまでどおり
//   インストーラが自分で札を作る。止まらない。
//
// ■ 配布物のURLは、そのつど短く作る
//
//   置いてあるのは非公開のバケット。
//   長く生きるURLを表に持つと、漏れたらそのまま落とせるし、
//   消すまで有効なままになる。
//
//   表に持つのは「どこに置いたか」だけ。
//   落とすときに5分だけ有効なURLを作って、そこへ送る。
//
// ■ 札の性質
//   ・32バイトの乱数。保存するのはハッシュだけ
//   ・15分で切れる
//   ・1人が同時に持てるのは1本（新しく作ると古いものは消える）
//   ・使ったら死ぬ（used_at が入る）

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { sha256, newPairToken } from "../../lib/devices.js";

const SQL = "db/057_device_one_pc.sql → 061_device_selfserve.sql";
const TTL_MIN = 15;
// 落とすためのURLは短く。長く生きるURLを表に持たない、という方針の片割れ
const DOWNLOAD_TTL_SEC = 300;
const DEFAULT_BUCKET = "agent";

export default async function handler(req, res) {
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

  if (req.method === "POST") return mint(res, ctx, user);
  if (req.method === "GET") {
    const q = new URL(req.url, "http://localhost").searchParams;
    if (q.get("policy")) return policy(res, ctx);
    if (q.get("download")) return download(res, ctx, q.get("download"));
    return status(res, ctx, q.get("token"));
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- ① 札を作る -------------------------------------------------------------
async function mint(res, ctx, user) {
  const sb = admin();
  const token = newPairToken();
  const expiresAt = new Date(Date.now() + TTL_MIN * 60000).toISOString();

  // 1人が同時に持てるのは1本。
  // 何度も押して札が溜まると、どれが生きているのか分からなくなる。
  // 使い終わったもの（used_at あり）は記録として残す
  await sb.from("gw_device_pairings").delete()
    .eq("employee_id", ctx.employee.id).eq("kind", "selfserve").is("used_at", null);

  const { error } = await sb.from("gw_device_pairings").insert({
    token_hash: sha256(token),
    kind: "selfserve",
    tenant_id: ctx.tenantId,
    employee_id: ctx.employee.id,
    expires_at: expiresAt,
  });
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[devices/setup] mint", error);
    return json(res, 500, { error: "server_error" });
  }

  // 期限切れの札を片付ける。溜めておく意味が無い
  await sb.from("gw_device_pairings").delete()
    .lt("expires_at", new Date(Date.now() - 86400000).toISOString());

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: "device.setup_started", target: ctx.employee.id,
    detail: { expiresAt },
  });

  return json(res, 200, {
    ok: true,
    // 画面はこれを ?pair= の待ち受けに使う。平文はここでしか出さない
    token,
    expiresInSec: TTL_MIN * 60,
    downloadUrl: `/api/devices/setup?download=${encodeURIComponent(token)}`,
    fileName: `EIGHT-Agent-Setup-${token}.exe`,
  });
}

// ---- 誰がインストーラを実行するか -------------------------------------------
//
// 既定は管理者・IT担当。
//
// 商用のコード署名証明書を使わないので、初回に Windows の警告が出る。
// 「警告が出たら詳細情報→実行」を社員に覚えさせると、
// 本物の怪しいEXEでも同じことをするようになる。
// セキュリティ教育として割に合わないので、社員には越えさせない。
//
// 警告なしで配れる道ができたら、設定を true にするだけで画面が変わる
async function policy(res, ctx) {
  const sb = admin();
  let selfInstall = false;
  try {
    const { data } = await sb.from("gw_device_policies")
      .select("self_install").eq("tenant_id", ctx.tenantId).maybeSingle();
    selfInstall = Boolean(data?.self_install);
  } catch (e) { /* 062 がまだ。安全側のまま */ }
  return json(res, 200, { selfInstall });
}

// ---- ② 進み具合を見る -------------------------------------------------------
async function status(res, ctx, token) {
  if (!token) return json(res, 400, { error: "bad_token" });
  const sb = admin();

  const { data: p, error } = await sb.from("gw_device_pairings")
    .select("id, kind, tenant_id, employee_id, hostname, os, browsers, used_at, expires_at")
    .eq("token_hash", sha256(token)).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "server_error" });
  }

  // 「無い」と「期限切れ」と「他人のもの」を言い分けない
  const mine = p && p.employee_id === ctx.employee.id && p.tenant_id === ctx.tenantId;
  if (!p || !mine || Date.parse(p.expires_at) < Date.now()) {
    return json(res, 404, { error: "expired", message: "この設定用のリンクは使えません" });
  }

  // インストーラが札を預けたか（hostname が入ったら、実行された）
  return json(res, 200, {
    state: p.used_at ? "done" : p.hostname ? "installing" : "waiting",
    pc: p.hostname ? { hostname: p.hostname, os: p.os, browsers: p.browsers || [] } : null,
    expiresAt: p.expires_at,
  });
}

// ---- ③ インストーラを落とす -------------------------------------------------
//
// 非公開のバケットに置いてあるので、長く生きるURLは持たない。
// 落とすたびに、短時間だけ有効なURLを作る。
// 漏れても、すぐ使えなくなる
async function download(res, ctx, token) {
  const sb = admin();

  const { data: p } = await sb.from("gw_device_pairings")
    .select("id, kind, tenant_id, employee_id, used_at, expires_at")
    .eq("token_hash", sha256(token)).maybeSingle();
  const mine = p && p.employee_id === ctx.employee.id && p.tenant_id === ctx.tenantId;
  if (!p || !mine || p.used_at || Date.parse(p.expires_at) < Date.now()) {
    return json(res, 404, { error: "expired", message: "この設定用のリンクは使えません" });
  }

  // 公開している版を探す
  let rel = null;
  try {
    const { data } = await sb.from("gw_device_releases")
      .select("version, bucket, object_path, url")
      .eq("tenant_id", ctx.tenantId).eq("published", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    rel = data || null;
  } catch (e) { /* 表がまだ無い */ }

  // 表に無ければ環境変数。置き場所のほうを先に見る
  const bucket = rel?.bucket || process.env.DEVICE_AGENT_BUCKET || DEFAULT_BUCKET;
  const objectPath = rel?.object_path || process.env.DEVICE_AGENT_OBJECT || null;
  const plainUrl = rel?.url || process.env.DEVICE_AGENT_URL || null;

  if (!objectPath && !plainUrl) {
    return json(res, 503, {
      error: "no_release",
      hint: "配布するインストーラがまだ登録されていません。管理部にご連絡ください",
    });
  }

  // ファイル名に札を入れて渡す。
  // インストーラは自分のファイル名から読むので、打ち込ませずに済む
  const fileName = `EIGHT-Agent-Setup-${token}.exe`;

  if (objectPath) {
    const signed = await signedUrl(sb, bucket, objectPath, fileName);
    if (!signed) {
      return json(res, 503, {
        error: "no_release",
        hint: "配布物を取り出せませんでした。管理部にご連絡ください",
      });
    }
    return redirect(res, signed);
  }

  // 外の場所に置いてある版。名前は決められないので、
  // インストーラは自分で札を作る側に回る（それでも設定はできる）
  if (!/^https:\/\//i.test(plainUrl)) {
    console.error("[devices/setup] https でない配布先:", plainUrl);
    return json(res, 503, { error: "no_release", hint: "配布先の設定が正しくありません" });
  }
  return redirect(res, plainUrl);
}

function redirect(res, to) {
  res.statusCode = 302;
  res.setHeader("Location", to);
  // 短命のURLを、途中に残さない
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end();
}

/**
 * Storage の中身を、短時間だけ落とせるURLにする。
 *
 * ファイル名を指定できるのがここの肝。
 * 名前に札を入れて渡すので、社員は何も打たなくてよい
 */
async function signedUrl(sb, bucket, objectPath, fileName) {
  try {
    const { data, error } = await sb.storage.from(bucket)
      .createSignedUrl(objectPath, DOWNLOAD_TTL_SEC, { download: fileName });
    if (error) throw error;
    return data?.signedUrl || null;
  } catch (e) {
    console.error("[devices/setup] 署名つきURLを作れません:", e?.message || e);
    return null;
  }
}
