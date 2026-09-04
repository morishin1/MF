// Google カレンダー連携（Drive と同じサービスアカウントを使う）
//
// 役割:
//   スペースの予約申請を、そのままカレンダーの予定として書き出す。
//     申請   … 仮の予定（tentative）として入れる。予定表の上では薄く表示され、
//              「まだ確定していないが押さえられている」ことが分かる
//     承認   … 確定（confirmed）に変える
//     却下   … 予定を消す
//     取消   … 予定を消す
//
// 必要な環境変数:
//   GOOGLE_SERVICE_ACCOUNT_JSON … Drive 連携と同じものを使う
//   GCAL_CALENDAR_ID            … 予約を書き込むカレンダーのID
//                                 （スペースごとに分ける場合はマスタ側で上書き）
//
// 事前の準備（これをしないと 404 / 403 になる）:
//   1. Google カレンダーで「エイト スペース予約」などのカレンダーを作る
//   2. そのカレンダーの設定 →「特定のユーザーとの共有」で、
//      サービスアカウントのメールアドレス（…@….iam.gserviceaccount.com）を
//      「予定の変更権限」で追加する
//   3. 同じ設定画面の「カレンダーの統合」にある カレンダーID を
//      GCAL_CALENDAR_ID に入れる
//
// 参加者（attendees）は入れていない。サービスアカウントは
// ドメイン全体の委任なしに参加者を追加できず、追加しようとすると
// 予定の作成そのものが失敗するため。申請者は本文と件名に書く。

import { getAccessToken, hasCredentials } from "./gdrive.js";

const API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";
export const TIME_ZONE = "Asia/Tokyo";

export function defaultCalendarId() {
  return (process.env.GCAL_CALENDAR_ID || "").trim();
}

/** カレンダー連携が使える状態か（鍵とカレンダーIDの両方が要る） */
export function isConfigured() {
  return hasCredentials() && Boolean(defaultCalendarId());
}

/** スペースごとの指定があればそれを、無ければ既定のカレンダーを使う */
export function calendarIdFor(space) {
  return (space?.calendar_id || "").trim() || defaultCalendarId();
}

async function calFetch(path, opts = {}) {
  const token = await getAccessToken(SCOPE);
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (r.status === 204) return {};
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = data.error?.message || `HTTP ${r.status}`;
    const err = new Error(`gcal_failed: ${detail}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

const cal = (id) => encodeURIComponent(id);

/**
 * 予定を作る。
 * @param {string} calendarId
 * @param {{summary:string, description?:string, location?:string,
 *          startsAt:string, endsAt:string, confirmed?:boolean}} ev
 * @returns {Promise<{id:string, htmlLink:string}>}
 */
export async function createEvent(calendarId, ev) {
  const data = await calFetch(`/calendars/${cal(calendarId)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(eventBody(ev)),
  });
  return { id: data.id, htmlLink: data.htmlLink || "" };
}

/** 予定の一部を書き換える（確定にする、時間を直す など） */
export async function patchEvent(calendarId, eventId, patch) {
  const data = await calFetch(`/calendars/${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return { id: data.id, htmlLink: data.htmlLink || "" };
}

/**
 * 予定を消す。すでに無い場合（404/410）は成功として扱う。
 * 予約を却下した理由が「カレンダーに予定が無い」ことであってはならないため。
 */
export async function deleteEvent(calendarId, eventId) {
  try {
    await calFetch(`/calendars/${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    return { deleted: true };
  } catch (e) {
    if (e.status === 404 || e.status === 410) return { deleted: false, alreadyGone: true };
    throw e;
  }
}

function eventBody({ summary, description, location, startsAt, endsAt, confirmed }) {
  return {
    summary,
    description: description || "",
    location: location || "",
    start: { dateTime: new Date(startsAt).toISOString(), timeZone: TIME_ZONE },
    end: { dateTime: new Date(endsAt).toISOString(), timeZone: TIME_ZONE },
    status: confirmed ? "confirmed" : "tentative",
  };
}

// ---- 予約 → 予定の文面 ------------------------------------------------------

/** 件名。承認待ちであることが予定表の一覧で分かるようにする */
export function eventSummary({ booking, space, applicantName, confirmed }) {
  const head = confirmed ? "" : "【承認待ち】";
  const who = applicantName ? `（${applicantName}）` : "";
  return `${head}${space?.name || "スペース"}｜${booking.title}${who}`;
}

export function eventDescription({ booking, applicantName }) {
  const lines = [
    `申請者: ${applicantName || "不明"}`,
    booking.headcount ? `人数: ${booking.headcount} 名` : null,
    booking.note ? `用途・備考:\n${booking.note}` : null,
    "",
    "エイト 社内ポータルのスペース予約から自動で作成されました。",
    "予定の変更・取り消しは、ポータル側で行ってください。",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

/**
 * 予約に対してカレンダー側をあるべき状態に合わせる。
 * 連携が未設定でも、通信に失敗しても、例外は投げずに結果を返す。
 * 予約そのものはポータル側で成立させ、カレンダーは「反映できたか」を持つ。
 *
 * @returns {Promise<{calendarId?:string, eventId?:string|null, link?:string|null,
 *                    error?:string|null, skipped?:string}>}
 */
export async function syncBooking({ booking, space, applicantName, action }) {
  if (!isConfigured() && !(space?.calendar_id && hasCredentials())) {
    return { skipped: "not_configured" };
  }
  const calendarId = calendarIdFor(space);
  if (!calendarId) return { skipped: "not_configured" };

  try {
    if (action === "delete") {
      if (booking.gcal_event_id) {
        await deleteEvent(booking.gcal_calendar_id || calendarId, booking.gcal_event_id);
      }
      return { calendarId, eventId: null, link: null, error: null };
    }

    const confirmed = action === "confirm";
    const body = {
      summary: eventSummary({ booking, space, applicantName, confirmed }),
      description: eventDescription({ booking, applicantName }),
      location: space?.name || "",
      startsAt: booking.starts_at,
      endsAt: booking.ends_at,
      confirmed,
    };

    if (booking.gcal_event_id) {
      const r = await patchEvent(booking.gcal_calendar_id || calendarId, booking.gcal_event_id, eventBody(body));
      return { calendarId: booking.gcal_calendar_id || calendarId, eventId: r.id, link: r.htmlLink, error: null };
    }
    const r = await createEvent(calendarId, body);
    return { calendarId, eventId: r.id, link: r.htmlLink, error: null };
  } catch (e) {
    console.error("[gcal] sync failed:", e?.message || e);
    return { calendarId, error: String(e?.message || e) };
  }
}
