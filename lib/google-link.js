// gw_google_links の出し入れ。
//
// refresh token は暗号化して入っていて、RLS のポリシーも置いていないので、
// service_role からしか触れない。読み書きの入口をここ1か所にまとめて、
// 画面にトークンが漏れる経路を作らないようにする。

import { admin } from "./supabase.js";
import {
  decrypt, encrypt, refreshAccessToken, listEvents,
  insertEvent, updateEvent, deleteEvent, canWrite,
} from "./google-oauth.js";

/** 画面に出してよい情報だけ。トークンは含めない */
export async function linkStatus(employeeId) {
  if (!employeeId) return { connected: false };
  try {
    const { data } = await admin()
      .from("gw_google_links")
      .select("google_email, connected_at, last_synced_at, sync_error, scope")
      .eq("employee_id", employeeId)
      .maybeSingle();
    if (!data) return { connected: false };
    return {
      connected: true,
      email: data.google_email,
      connectedAt: data.connected_at,
      lastSyncedAt: data.last_synced_at,
      error: data.sync_error,
      // 読むだけの権限でつないだ人。書き出しにはつなぎ直しが要る
      canWrite: canWrite(data.scope),
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

/**
 * 社内で入れた予定を、本人の Google カレンダーへ書き出す。
 *
 * 2回押しても向こうに2件できないよう、書き出したときの id を控えておき、
 * 2回目以降は上書きにする。向こうで消されていたら入れ直す。
 *
 * 例外は投げず、理由を付けて返す。書き出しに失敗しても社内の予定は残る。
 * @returns {Promise<{ok:boolean, gcalEventId?:string, link?:string, reason?:string, hint?:string}>}
 */
export async function pushEvent(employeeId, ev) {
  const link = await tokenFor(employeeId);
  if (!link.ok) return link;

  try {
    let result = ev.gcal_event_id
      ? await updateEvent(link.token, ev.gcal_event_id, ev)
      : null;
    // 上書きしようとして向こうに無かった場合は入れ直す
    if (!result) result = await insertEvent(link.token, ev);
    return { ok: true, gcalEventId: result.id, link: result.link };
  } catch (e) {
    return { ok: false, ...describe(e) };
  }
}

/** 書き出したものを Google 側から取り消す */
export async function unpushEvent(employeeId, gcalEventId) {
  if (!gcalEventId) return { ok: true };
  const link = await tokenFor(employeeId);
  if (!link.ok) return link;
  try {
    await deleteEvent(link.token, gcalEventId);
    return { ok: true };
  } catch (e) {
    return { ok: false, ...describe(e) };
  }
}

/** 書き出しに使えるアクセストークンを用意する。使えない理由はここで判定する */
async function tokenFor(employeeId) {
  if (!employeeId) return { ok: false, reason: "no_employee" };

  let row;
  try {
    const { data } = await admin()
      .from("gw_google_links").select("refresh_token, scope")
      .eq("employee_id", employeeId).maybeSingle();
    row = data;
  } catch {
    return { ok: false, reason: "unavailable", hint: "Google連携の準備ができていません（db/018 未適用）" };
  }
  if (!row) {
    return { ok: false, reason: "not_connected", hint: "先に Google カレンダーと連携してください" };
  }
  // 読むだけの権限でつないだ人。書き込みだけ 403 になるより、先に案内する
  if (!canWrite(row.scope)) {
    return {
      ok: false, reason: "reconnect_required",
      hint: "書き出しの許可がまだありません。「つなぎ直す」を押して、もう一度 Google の同意画面で許可してください",
    };
  }

  try {
    return { ok: true, token: await refreshAccessToken(decrypt(row.refresh_token)) };
  } catch (e) {
    return { ok: false, reason: "token_failed", hint: "Google との接続が切れています。つなぎ直してください", detail: String(e?.message || e) };
  }
}

function describe(e) {
  const m = String(e?.message || e);
  if (/HTTP 401|HTTP 403|insufficient/i.test(m)) {
    return {
      reason: "forbidden",
      hint: "Google に断られました。「つなぎ直す」で、予定の書き込みを許可してください",
      detail: m,
    };
  }
  return { reason: "failed", hint: "Google カレンダーへ書き出せませんでした", detail: m };
}
