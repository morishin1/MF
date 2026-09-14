// POST /api/devices/release
//   GitHub Actions が、組み立てた版を配れる状態にするために呼ぶ。
//
// ■ なぜ API を挟むのか（service_role を GitHub に置かない）
//
//   Storage へ上げて gw_device_releases に入れるだけなら、
//   service_role の鍵を GitHub Secrets に置けば済む。置かない。
//
//   あの鍵は、持っていれば**全テーブルを読み書きできる**。
//   給与も、健康診断の記録も、退職者の契約書も含まれる。
//   「配布物を1つ置く」ためにそこまでの力を渡す理由がない。
//
//   代わりに、この口だけを開ける合言葉（DEVICE_RELEASE_TOKEN）を渡す。
//   これで GitHub 側が持つ力は「エージェントの版を1つ出す」に閉じる。
//   漏れても、直すのは Vercel の環境変数を1つ替えるだけ。
//
// ■ 3回に分けて呼ぶ
//
//   1) begin   … 同じ版が無いか見て、上げる先の短命なURLを返す
//   2) verify  … 上がったものを読み直して、大きさとハッシュを突き合わせる
//   3) publish … 署名つきで表に入れて、配れる状態にする
//
//   分けているのは、**表に入る前に中身を確かめる**ため。
//   先に published にしてから確かめると、その隙に全PCが
//   壊れたものを取りにいく。
//
// ■ 同じ版を黙って上書きしない
//
//   begin で、Storage と表の両方を見る。どちらかにあれば 409 で止める。
//   配った版を差し替えると、既に入れたPCと、これから入れるPCで
//   中身が違うことになる。しかも署名は通ってしまうので気づけない。
//
// ■ 表に入れるのは「置き場所」であって URL ではない
//
//   バケットは非公開のまま。落とすURLは、そのつど5分だけ作る
//   （api/devices/manifest.js）。長生きするURLを表に持たない。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const BUCKET = "agent";
const FILE = "EIGHT-Agent-Setup.exe";

// 上げ直しのために読むだけ。長く生かす理由がない
const READ_TTL = 300;

// 版の形。ファイル名にも Storage のパスにも表の一意キーにもなる
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/;

// 実行ファイルの大きさの上限。壊れた値で表を埋めない
const MAX_BYTES = 200 * 1024 * 1024;
const MIN_BYTES = 5 * 1024 * 1024;

// ブラウザ拡張は、同じ場所に置き直す。
// 拡張の版は manifest.json の中にあり、ここの版とは別物
const EXT_FILES = {
  "eight-ext.crx": "application/x-chrome-extension",
  "updates.xml": "application/xml",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

  const body = await readJson(req);
  const action = String(body.action || "");

  let tenantId;
  try {
    tenantId = await resolveTenant();
  } catch (e) {
    return json(res, 500, { error: "tenant_unresolved", hint: e.message });
  }

  try {
    switch (action) {
      case "begin":
        return await begin(res, tenantId, body);
      case "verify":
        return await verify(res, body);
      case "publish":
        return await publish(res, tenantId, body);
      case "ext":
        return await ext(res, body);
      default:
        return json(res, 400, {
          error: "unknown_action",
          allowed: ["begin", "verify", "publish", "ext"],
        });
    }
  } catch (e) {
    console.error("[devices/release]", e?.message || e);
    return json(res, 500, { error: "server_error", detail: e?.message || String(e) });
  }
}

// ---- 合言葉 -----------------------------------------------------------------

// 合言葉が設定されていなければ、この口は閉じておく。
// 「まだ決めていない」を「誰でも通れる」にしない
function authorized(req) {
  const want = process.env.DEVICE_RELEASE_TOKEN || "";
  if (!want || want.length < 24) return false;

  const given = String(req.headers.authorization || "");
  const m = given.match(/^Bearer\s+(.+)$/);
  if (!m) return false;

  // 長さで早く抜けると、比べているうちに合言葉の長さが分かる。
  // 先に同じ長さへ均してから比べる
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---- どのテナントのものか -----------------------------------------------------

async function resolveTenant() {
  const fixed = process.env.DEVICE_RELEASE_TENANT_ID;
  if (fixed) return fixed;

  // 1社しか無いなら、それ。増えたら env で決めてもらう。
  // 勝手に1社目を選ぶと、別の会社の台帳に版が入る
  const { data, error } = await admin().from("tenants").select("id").limit(2);
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("tenants がありません");
  if (data.length > 1) {
    throw new Error("テナントが複数あります。DEVICE_RELEASE_TENANT_ID を設定してください");
  }
  return data[0].id;
}

// ---- 1) 上げる先を作る ---------------------------------------------------------

async function begin(res, tenantId, body) {
  const version = String(body.version || "");
  if (!VERSION_RE.test(version)) {
    return json(res, 400, { error: "bad_version", hint: "0.3.1 のような形です" });
  }
  const objectPath = `${version}/${FILE}`;
  const sb = admin();

  // 表にあるか
  const { data: row, error } = await sb.from("gw_device_releases")
    .select("id, published").eq("tenant_id", tenantId).eq("version", version).maybeSingle();
  if (error) return json(res, 500, { error: "db_error", detail: error.message });
  if (row) {
    return json(res, 409, {
      error: "version_exists",
      where: "gw_device_releases",
      hint: `版 ${version} は既に登録されています。版を上げてください`,
    });
  }

  // Storage にあるか。表に無くても、置きっぱなしのことがある
  if (await objectExists(sb, BUCKET, objectPath)) {
    return json(res, 409, {
      error: "version_exists",
      where: "storage",
      hint: `agent/${objectPath} は既にあります。版を上げてください`,
    });
  }

  // createSignedUploadUrl は、既にあるものには出ない。
  // 上の2つを抜けてもここで止まる（最後の砦）
  const { data, error: se } = await sb.storage.from(BUCKET).createSignedUploadUrl(objectPath);
  if (se) {
    const dup = /exists|duplicate/i.test(se.message || "");
    return json(res, dup ? 409 : 500, {
      error: dup ? "version_exists" : "sign_failed",
      where: "storage",
      detail: se.message,
    });
  }

  return json(res, 200, {
    ok: true, bucket: BUCKET, objectPath,
    uploadUrl: absolute(data.signedUrl), token: data.token,
  });
}

// ---- 2) 上がったものを確かめる ---------------------------------------------------

async function verify(res, body) {
  const version = String(body.version || "");
  if (!VERSION_RE.test(version)) return json(res, 400, { error: "bad_version" });

  const objectPath = `${version}/${FILE}`;
  const sb = admin();

  const size = await objectSize(sb, BUCKET, objectPath);
  if (size === null) {
    return json(res, 404, { error: "not_uploaded", hint: `agent/${objectPath} がありません` });
  }

  const want = Number(body.size_bytes || 0);
  if (want && want !== size) {
    return json(res, 409, {
      error: "size_mismatch", uploaded: size, expected: want,
      hint: "上げ切れていません。組み立てからやり直してください",
    });
  }

  // 読み直して、上げたものと同じか確かめてもらう。
  // ここでハッシュを突き合わせてから publish へ進む
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(objectPath, READ_TTL);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });

  return json(res, 200, { ok: true, size, url: data.signedUrl });
}

// ---- 3) 配れる状態にする ---------------------------------------------------------

async function publish(res, tenantId, body) {
  const version = String(body.version || "");
  if (!VERSION_RE.test(version)) return json(res, 400, { error: "bad_version" });

  const sha256 = String(body.sha256 || "").toLowerCase();
  const sizeBytes = Number(body.size_bytes || 0);
  const signature = String(body.signature || "");
  const keyId = String(body.key_id || "");

  // そろっていないものを表に入れない。
  // 入れてしまうと、エージェントは「確かめられない版」を見にくる
  if (!/^[0-9a-f]{64}$/.test(sha256)) return json(res, 400, { error: "bad_sha256" });
  if (!Number.isInteger(sizeBytes) || sizeBytes < MIN_BYTES || sizeBytes > MAX_BYTES) {
    return json(res, 400, { error: "bad_size", hint: `${MIN_BYTES}〜${MAX_BYTES} バイトです` });
  }
  if (signature.length < 40 || signature.length > 200) return json(res, 400, { error: "bad_signature" });
  if (!keyId) return json(res, 400, { error: "bad_key_id" });

  const objectPath = `${version}/${FILE}`;
  const sb = admin();

  // 上がっているか、大きさは合っているか。もう一度見る。
  // verify から publish までのあいだに差し替えられていないこと
  const size = await objectSize(sb, BUCKET, objectPath);
  if (size === null) return json(res, 404, { error: "not_uploaded" });
  if (size !== sizeBytes) {
    return json(res, 409, { error: "size_mismatch", uploaded: size, expected: sizeBytes });
  }

  const { data, error } = await sb.from("gw_device_releases").insert({
    tenant_id: tenantId,
    version,
    bucket: BUCKET,
    object_path: objectPath,
    url: null,
    sha256,
    size_bytes: sizeBytes,
    signature,
    key_id: keyId,
    notes: String(body.notes || "").slice(0, 500) || null,
    published: true,
  }).select("id, version, created_at").single();

  if (error) {
    // 一意キー（tenant_id, version）で弾かれた＝誰かが先に入れた
    if (/duplicate key|unique/i.test(error.message || "")) {
      return json(res, 409, { error: "version_exists", where: "gw_device_releases" });
    }
    return json(res, 500, { error: "db_error", detail: error.message });
  }

  await gwLog({
    tenantId, actorId: null, action: "device_release_published",
    target: data.id,
    detail: { version, object_path: objectPath, size_bytes: sizeBytes, key_id: keyId, by: "github-actions" },
  });

  return json(res, 200, { ok: true, id: data.id, version, bucket: BUCKET, objectPath });
}

// ---- ブラウザ拡張 -------------------------------------------------------------

// 拡張は、同じ場所に置き直す。
// ブラウザは updates.xml の版を見て入れ替えるので、置き場所は固定でよい
async function ext(res, body) {
  const name = String(body.file || "");
  if (!Object.prototype.hasOwnProperty.call(EXT_FILES, name)) {
    return json(res, 400, { error: "bad_file", allowed: Object.keys(EXT_FILES) });
  }
  const sb = admin();
  const path = `ext/${name}`;

  // 置き直すので、先にあるものを消す。
  // createSignedUploadUrl は、既にあるものには出ない
  await sb.storage.from(BUCKET).remove([path]).catch(() => {});

  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });

  return json(res, 200, {
    ok: true, bucket: BUCKET, objectPath: path,
    uploadUrl: absolute(data.signedUrl), token: data.token,
    contentType: EXT_FILES[name],
  });
}

// ---- Storage をのぞく ---------------------------------------------------------

async function objectSize(sb, bucket, objectPath) {
  const at = objectPath.lastIndexOf("/");
  const dir = at < 0 ? "" : objectPath.slice(0, at);
  const name = at < 0 ? objectPath : objectPath.slice(at + 1);

  const { data, error } = await sb.storage.from(bucket).list(dir, { search: name, limit: 100 });
  if (error) return null;
  const hit = (data || []).find((f) => f.name === name);
  if (!hit) return null;
  return Number(hit.metadata?.size ?? 0) || 0;
}

async function objectExists(sb, bucket, objectPath) {
  return (await objectSize(sb, bucket, objectPath)) !== null;
}

// createSignedUploadUrl が返すのは /object/upload/sign/... という相対の形。
// 呼ぶ側（Actions）はそのままでは使えないので、絶対のURLにして返す
function absolute(signed) {
  if (!signed) return null;
  if (/^https?:\/\//i.test(signed)) return signed;
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const path = signed.startsWith("/") ? signed : `/${signed}`;
  return `${base}/storage/v1${path}`;
}
