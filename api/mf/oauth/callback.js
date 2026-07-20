// GET /api/mf/oauth/callback?code=...&state=...
// MF からのリダイレクト受け口（公開）。state 署名を検証し、認可コードをトークンへ交換して保存。
// 完了後は admin.html にリダイレクトして結果を通知する。

import { verifyState, exchangeCode, saveCredentials } from "../../../lib/mf-oauth.js";
import { admin } from "../../../lib/supabase.js";

export default async function handler(req, res) {
  const { code, state, error, error_description } = req.query || {};

  const redirect = (q) => {
    res.statusCode = 302;
    res.setHeader("Location", "/admin.html" + q);
    res.end();
  };

  if (error) return redirect(`?mf=error&reason=${encodeURIComponent(error_description || error)}`);
  if (!code || !state) return redirect(`?mf=error&reason=missing_code`);

  let st;
  try {
    st = verifyState(state);
  } catch (e) {
    return redirect(`?mf=error&reason=${encodeURIComponent("bad_state:" + (e?.message || ""))}`);
  }

  try {
    const token = await exchangeCode(code);
    await saveCredentials(admin(), { tenantId: st.tenantId, clientId: st.clientId, token });
    return redirect(`?mf=connected`);
  } catch (e) {
    return redirect(`?mf=error&reason=${encodeURIComponent(String(e?.message || e))}`);
  }
}
