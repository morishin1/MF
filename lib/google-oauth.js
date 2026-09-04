// 各自の Google カレンダーを読むための OAuth（認可コードフロー）。
//
// スペース予約（lib/gcal.js）はサービスアカウントで「会社の共有カレンダーに書く」。
// こちらは本人の同意で「その人のカレンダーを読む」。まったく別の仕組み。
//
// サービスアカウント＋ドメイン全体の委任でも個人のカレンダーは読めるが、
// それは全社員のカレンダーを本人の同意なく読める権限になる。読み取りのために
// そこまでの権限を持つべきではないので、一人ずつ同意してもらう形にした。
// 本人はいつでも連携を切れる。
//
// 必要な環境変数:
//   GOOGLE_OAUTH_CLIENT_ID      … Google Cloud で作るウェブアプリのクライアントID
//   GOOGLE_OAUTH_CLIENT_SECRET  … 同シークレット（秘密）
//   （任意）GOOGLE_OAUTH_REDIRECT_URI … 既定 https://mf.8grp.co.jp/api/google/callback
//
// 暗号鍵と state の署名鍵は CLIENT_SECRET から用途別に導いている。
// 環境変数を増やさずに済ませるため。CLIENT_SECRET を替えると
// 既存の連携は復号できなくなり、各自の再連携が要る（そのときは案内する）。

import crypto from "node:crypto";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

const SCOPES = [
  "openid",
  "email",
  // 読み取り専用。予定を書き換える権限は求めない
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

export function config() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || "https://mf.8grp.co.jp/api/google/callback",
  };
}

export function isConfigured() {
  const c = config();
  return Boolean(c.clientId && c.clientSecret);
}

// ---- 鍵導出（用途ごとに別鍵） ----
function keyFor(purpose) {
  return crypto.createHash("sha256")
    .update((process.env.GOOGLE_OAUTH_CLIENT_SECRET || "") + ":gcal:" + purpose)
    .digest();
}

// ---- refresh token の暗号化（AES-256-GCM）→ base64 ----
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFor("enc"), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decrypt(b64) {
  const raw = Buffer.from(String(b64), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", keyFor("enc"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

// ---- state の署名・検証 ----
// callback はログイン情報を持たずに開かれるので、誰の連携かは state に載せる。
// 署名が無いと、他人の社員IDを書いた state を投げ込まれて連携先をすり替えられる。
export function signState(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const sig = crypto.createHmac("sha256", keyFor("state")).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(s) {
  const [body, sig] = String(s || "").split(".");
  if (!body || !sig) throw new Error("bad_state");
  const expected = crypto.createHmac("sha256", keyFor("state")).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("bad_signature");
  const obj = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  // 有効期限を短くしているのは、取り違えの窓を小さくするため
  if (!obj.exp || Date.now() > obj.exp) throw new Error("state_expired");
  return obj;
}

// ---- 認可URL ----
export function buildAuthorizeUrl(state, loginHint) {
  const c = config();
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: "code",
    scope: SCOPES,
    state,
    // refresh token は「初回の同意」でしか返ってこない。
    // 連携をやり直したときにも確実に受け取れるよう、毎回同意を出す
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${AUTH_URL}?${p.toString()}`;
}

// ---- トークン ----
async function tokenRequest(params) {
  const c = config();
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`google_token_failed: ${data.error_description || data.error || `HTTP ${r.status}`}`);
  }
  return data;
}

/** 認可コード → トークン一式。refresh_token と、つないだアドレスを返す */
export async function exchangeCode(code) {
  const data = await tokenRequest({
    code,
    redirect_uri: config().redirectUri,
    grant_type: "authorization_code",
  });
  return {
    refreshToken: data.refresh_token || null,
    accessToken: data.access_token,
    scope: data.scope || "",
    email: emailFromIdToken(data.id_token),
  };
}

export async function refreshAccessToken(refreshToken) {
  const data = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return data.access_token;
}

/** 連携を切るときに Google 側でも失効させる。失敗しても行は消す */
export async function revoke(refreshToken) {
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, { method: "POST" });
  } catch (e) {
    console.error("[google-oauth] revoke failed:", e?.message || e);
  }
}

// id_token は Google から TLS で直接受け取っているので、ここでは署名検証まではしない。
// 使うのは画面に出すアドレスだけで、認可の判断には使っていない。
function emailFromIdToken(idToken) {
  try {
    const payload = String(idToken || "").split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).email || null;
  } catch {
    return null;
  }
}

// ---- 予定の取得 ----
/**
 * その人の主カレンダーから、期間内の予定を取る。
 * 繰り返しの予定は singleEvents で1件ずつに展開してもらう
 * （こちらで繰り返し規則を解釈すると、例外日の扱いを必ず間違える）。
 */
export async function listEvents(accessToken, { from, to, max = 250 }) {
  const p = new URLSearchParams({
    timeMin: new Date(from).toISOString(),
    timeMax: new Date(to).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(max),
  });
  const r = await fetch(`${API}/calendars/primary/events?${p.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`google_events_failed: ${data.error?.message || `HTTP ${r.status}`}`);

  return (data.items || [])
    // 辞退した予定は自分の予定表には出さない
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      id: e.id,
      title: e.summary || "(件名なし)",
      location: e.location || null,
      // 終日の予定は date、時刻つきは dateTime で返ってくる
      allDay: !e.start?.dateTime,
      startsAt: e.start?.dateTime || (e.start?.date ? `${e.start.date}T00:00:00+09:00` : null),
      endsAt: e.end?.dateTime || (e.end?.date ? `${e.end.date}T00:00:00+09:00` : null),
      link: e.htmlLink || null,
    }))
    .filter((e) => e.startsAt);
}
