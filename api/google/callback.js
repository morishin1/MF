// GET /api/google/callback?code=&state=
//
// Google の同意画面から戻ってくる先。ログインのトークンは付いてこないので、
// 誰の連携かは state（HMAC 署名つき）だけで決める。署名が合わなければ何もしない。
//
// 画面ではなく予定ページへ戻す。結果はクエリで渡し、あちらで文言にする。
// ここで HTML を返すと、連携のたびに見慣れないページが挟まることになる。

import { verifyState, exchangeCode } from "../../lib/google-oauth.js";
import { saveLink } from "../../lib/google-link.js";
import { gwLog } from "../../lib/gw-audit.js";

const BACK = "/schedule.html";

export default async function handler(req, res) {
  const q = new URL(req.url, "http://localhost").searchParams;

  // 利用者が同意画面で「キャンセル」を押した場合もここに来る
  if (q.get("error")) return back(res, "cancelled");

  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state) return back(res, "bad_request");

  let claim;
  try {
    claim = verifyState(state);
  } catch (e) {
    // 署名違い・期限切れ。どちらも同じ扱いにして、理由は外に出さない
    console.error("[google/callback] bad state:", e?.message || e);
    return back(res, "expired");
  }

  try {
    const { refreshToken, email, scope } = await exchangeCode(code);
    if (!refreshToken) {
      // 以前の同意が残っていると refresh token が返らないことがある。
      // prompt=consent を付けているので通常は起きないが、起きたら再試行を促す
      return back(res, "no_refresh_token");
    }
    await saveLink({
      employeeId: claim.e, tenantId: claim.t, refreshToken, email, scope,
    });
    await gwLog({
      tenantId: claim.t, actorId: claim.e,
      action: "google.connected", target: claim.e, detail: { email },
    });
    return back(res, null);
  } catch (e) {
    console.error("[google/callback] failed:", e?.message || e);
    return back(res, "failed");
  }
}

function back(res, error) {
  res.statusCode = 302;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", error ? `${BACK}?gcal=${encodeURIComponent(error)}` : `${BACK}?gcal=ok`);
  res.end();
}
