// gw_google_links の出し入れ。
//
// refresh token は暗号化して入っていて、RLS のポリシーも置いていないので、
// service_role からしか触れない。読み書きの入口をここ1か所にまとめて、
// 画面にトークンが漏れる経路を作らないようにする。

import { admin } from "./supabase.js";
import { decrypt, encrypt, refreshAccessToken, listEvents } from "./google-oauth.js";

/** 画面に出してよい情報だけ。トークンは含めない */
export async function linkStatus(employeeId) {
  if (!employeeId) return { connected: false };
  try {
    const { data } = await admin()
      .from("gw_google_links")
      .select("google_email, connected_at, last_synced_at, sync_error")
      .eq("employee_id", employeeId)
      .maybeSingle();
    if (!data) return { connected: false };
    return {
      connected: true,
      email: data.google_email,
      connectedAt: data.connected_at,
      lastSyncedAt: data.last_synced_at,
      error: data.sync_error,
    };
  } catch {
    // テーブル未作成（018 未適用）でも画面は出したい
    return { connected: false, unavailable: true };
  }
}

export async function saveLink({ employeeId, tenantId, refreshToken, email, scope }) {
  const { error } = await admin().from("gw_google_links").upsert({
    employee_id: employeeId,
    tenant_id: tenantId,
    google_email: email,
    refresh_token: encrypt(refreshToken),
    scope,
    connected_at: new Date().toISOString(),
    sync_error: null,
  }, { onConflict: "employee_id" });
  if (error) throw new Error(error.message);
}

/** 連携を切る。戻り値は Google 側でも失効させるための refresh token */
export async function removeLink(employeeId) {
  const sb = admin();
  const { data } = await sb
    .from("gw_google_links")
    .select("refresh_token")
    .eq("employee_id", employeeId)
    .maybeSingle();

  await sb.from("gw_google_links").delete().eq("employee_id", employeeId);
  if (!data?.refresh_token) return null;
  try { return decrypt(data.refresh_token); } catch { return null; }
}

/**
 * その人の Google カレンダーの予定を取る。
 * 例外は投げない。連携が切れていても予定画面そのものは出したいので、
 * 失敗は行に記録して空で返す（画面には「連携が切れています」と出る）。
 */
export async function fetchExternalEvents(employeeId, { from, to }) {
  if (!employeeId) return { connected: false, events: [] };

  const sb = admin();
  let row;
  try {
    const { data } = await sb
      .from("gw_google_links")
      .select("refresh_token, google_email")
      .eq("employee_id", employeeId)
      .maybeSingle();
    row = data;
  } catch {
    return { connected: false, events: [] };   // 018 未適用
  }
  if (!row) return { connected: false, events: [] };

  try {
    const token = await refreshAccessToken(decrypt(row.refresh_token));
    const events = await listEvents(token, { from, to });
    await sb.from("gw_google_links")
      .update({ last_synced_at: new Date().toISOString(), sync_error: null })
      .eq("employee_id", employeeId);
    return { connected: true, email: row.google_email, events };
  } catch (e) {
    const message = String(e?.message || e);
    console.error("[google-link] fetch failed:", message);
    await sb.from("gw_google_links")
      .update({ sync_error: message.slice(0, 300) })
      .eq("employee_id", employeeId)
      .then(() => {}, () => {});
    return { connected: true, email: row.google_email, events: [], error: message };
  }
}
