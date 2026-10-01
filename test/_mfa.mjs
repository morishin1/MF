// テスト用の「二段階認証を済ませた（aal2）」アクセストークン。
//
// lib/mfa.js の aalOf はトークン（JWT）の payload の aal だけを見る（署名は Supabase 側で確かめる）。
// 強制日（ENFORCE_FROM：2026-10-01）からは、MFA の対象の人は aal2 でないと機密の API を通れない。
// 「Bearer x」のような読めないトークンだと aal1 扱いになり、日付が来たとたんにテストが mfa_required で落ちる。
//
// 機密の API を呼ぶテストは、これで「MFA 済みの利用者」として呼ぶ。本番の MFA の決まりは変えない
// （MFA が無いと止まることは test/mfatest.mjs が見張る）。
export function mfaToken(aal = "aal2", sub = "u-test") {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, aal })}.sig`;
}

/** Authorization ヘッダーの値（aal2） */
export const MFA_AUTH = `Bearer ${mfaToken()}`;
