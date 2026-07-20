// MF OAuth2（認可コードフロー / CLIENT_SECRET_BASIC）
//
// 役割:
//   - 認可URLの生成、認可コード→トークン交換、リフレッシュ
//   - state の署名/検証（callback は公開エンドポイントのため改ざん防止に必須）
//   - アクセストークン/リフレッシュトークンの暗号化保存（accounting_credentials）
//
// 必要な環境変数:
//   MF_CLIENT_SECRET  … MFアプリの Client Secret（必須・秘密）
//   MF_APP_SECRET     … 暗号鍵/署名鍵の導出元（必須・秘密。ランダム文字列）
//   （任意で上書き可）MF_CLIENT_ID / MF_REDIRECT_URI / MF_AUTH_URL / MF_TOKEN_URL / MF_SCOPES

import crypto from "node:crypto";

export function config() {
  return {
    clientId: process.env.MF_CLIENT_ID || "396078215245039",
    clientSecret: process.env.MF_CLIENT_SECRET || "",
    redirectUri: process.env.MF_REDIRECT_URI || "https://mf.8grp.co.jp/api/mf/oauth/callback",
    authUrl: process.env.MF_AUTH_URL || "https://api.biz.moneyforward.com/authorize",
    tokenUrl: process.env.MF_TOKEN_URL || "https://api.biz.moneyforward.com/token",
    scopes: process.env.MF_SCOPES || "mfc/admin/office.read",
  };
}

export function isConfigured() {
  return Boolean(process.env.MF_CLIENT_SECRET && process.env.MF_APP_SECRET);
}

// ---- 鍵導出（用途ごとに別鍵） ----
function keyFor(purpose) {
  return crypto.createHash("sha256").update((process.env.MF_APP_SECRET || "") + ":" + purpose).digest();
}

// ---- トークン暗号化（AES-256-GCM）→ base64 ----
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFor("enc"), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}
export function decrypt(b64) {
  const raw = Buffer.from(String(b64), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", keyFor("enc"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// ---- state 署名/検証（HMAC-SHA256, base64url） ----
export function signState(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", keyFor("state")).update(body).digest("base64url");
  return body + "." + sig;
}
export function verifyState(s) {
  const [body, sig] = String(s).split(".");
  if (!body || !sig) throw new Error("bad_state");
  const expected = crypto.createHmac("sha256", keyFor("state")).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("bad_signature");
  const obj = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (obj.exp && Date.now() > obj.exp) throw new Error("state_expired");
  return obj;
}

// ---- 認可URL ----
export function buildAuthorizeUrl(state) {
  const c = config();
  const p = new URLSearchParams({
    response_type: "code",
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    scope: c.scopes,
    state,
  });
  return `${c.authUrl}?${p.toString()}`;
}

// ---- トークンエンドポイント呼び出し（CLIENT_SECRET_BASIC） ----
async function tokenRequest(params) {
  const c = config();
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");
  const r = await fetch(c.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error("token_request_failed: " + (data.error_description || data.error || `HTTP ${r.status}`));
  }
  return data; // { access_token, token_type, expires_in, refresh_token, scope, ... }
}

export function exchangeCode(code) {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: config().redirectUri });
}
export function refreshTokens(refreshToken) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

// ---- 資格情報の保存 / 参照 ----
export async function saveCredentials(sb, { tenantId, clientId, token, externalOfficeId = null }) {
  const expiresAt = token.expires_in
    ? new Date(Date.now() + (Number(token.expires_in) - 30) * 1000).toISOString()
    : null;
  const scopes = token.scope ? token.scope.split(/\s+/) : config().scopes.split(/\s+/);
  const row = {
    tenant_id: tenantId,
    client_id: clientId,
    software: "mf",
    encrypted_token: encrypt(token.access_token),
    refresh_token_encrypted: token.refresh_token ? encrypt(token.refresh_token) : null,
    scopes,
    expires_at: expiresAt,
    external_office_id: externalOfficeId,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("accounting_credentials").upsert(row, { onConflict: "client_id,software" });
  if (error) throw new Error("save_credentials_failed: " + error.message);
}

// 接続状態（トークン本体は返さない）
export async function mfStatus(sb, clientId) {
  const { data } = await sb
    .from("accounting_credentials")
    .select("scopes, expires_at, external_office_id, updated_at")
    .eq("client_id", clientId).eq("software", "mf").maybeSingle();
  if (!data) return { connected: false };
  return {
    connected: true,
    scopes: data.scopes || [],
    expires_at: data.expires_at,
    external_office_id: data.external_office_id,
    updated_at: data.updated_at,
  };
}

// 有効なアクセストークンを取得（期限切れ間近なら自動リフレッシュして保存）
export async function getValidAccessToken(sb, clientId) {
  const { data, error } = await sb
    .from("accounting_credentials")
    .select("tenant_id, client_id, encrypted_token, refresh_token_encrypted, expires_at, external_office_id")
    .eq("client_id", clientId).eq("software", "mf").maybeSingle();
  if (error) throw new Error("load_credentials_failed: " + error.message);
  if (!data) return null;

  const notExpired = data.expires_at && new Date(data.expires_at).getTime() > Date.now();
  if (notExpired) return { accessToken: decrypt(data.encrypted_token), externalOfficeId: data.external_office_id };

  // リフレッシュ
  if (!data.refresh_token_encrypted) return null;
  const token = await refreshTokens(decrypt(data.refresh_token_encrypted));
  // refresh_token が返らない場合は既存を維持
  if (!token.refresh_token) token.refresh_token = decrypt(data.refresh_token_encrypted);
  await saveCredentials(sb, {
    tenantId: data.tenant_id, clientId: data.client_id, token, externalOfficeId: data.external_office_id,
  });
  return { accessToken: token.access_token, externalOfficeId: data.external_office_id };
}
