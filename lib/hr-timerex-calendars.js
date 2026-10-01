// TimeRex の予約枠（calendar_url_path）→ 面談の種類。設定はこのファイル1か所にまとめる。
//
// ■ どの予約枠からの予約か、で面談の種類を決める
//   カジュアル面談の予約枠と、社長面談の予約枠は別の URL（calendar_url_path）。
//   Webhook の calendar_url_path をここで引いて、casual / ceo を決める。
//   知らない予約枠は勝手にカジュアル扱いにしない（unknown_timerex_calendar で止める）。
//
// ■ 対応表の作り方（上ほど優先）
//   1. 環境変数 TIMEREX_HR_CALENDARS … JSON で { "<calendar_url_path>": "casual" | "ceo" }
//   2. 環境変数 TIMEREX_CASUAL_INTERVIEW_URL / TIMEREX_CEO_INTERVIEW_URL … 予約ページの URL の
//      最後の部分（…/<calendar_url_path>）を、それぞれ casual / ceo として使う
//      （カジュアル面談の URL は応募者詳細の「日程調整URL」にも使っている現行の設定）
//   3. 下の DEFAULT_CALENDARS（確認済みの予約枠）
//
// ■ 面談の種類ごとの動き（KIND_RULES）
//   応募者を探すときの対象ステータス・予約が入ったときの stage・キャンセルで戻す先を持つ。

/** 確認済みの予約枠。値は calendar_url_path の最後の部分 */
export const DEFAULT_CALENDARS = {
  "98b26445": "ceo",   // 社長面談（社長最終面談）の予約枠
};

export const KIND_RULES = {
  casual: {
    label: "カジュアル面談",
    searchStatuses: ["scheduling"],                        // guest_email で探すときの対象
    booked: { stage: "casual_interview", status: "interview_scheduled" },
    canceled: { status: "scheduling" },                    // 日程調整のやり直し
  },
  ceo: {
    label: "社長面談",
    searchStatuses: ["ceo_interview_pending"],
    booked: { stage: "ceo_interview", status: "interview_scheduled" },
    canceled: { stage: "ceo_interview", status: "ceo_interview_pending" },
  },
};
export const TIMEREX_KINDS = Object.keys(KIND_RULES);

/** "https://timerex.net/s/abc/98b26445?x=1" や "abc/98b26445" → "98b26445" */
export function calendarKey(pathOrUrl) {
  const s = String(pathOrUrl || "").trim();
  if (!s) return null;
  let p = s;
  try { if (/^https?:\/\//i.test(s)) p = new URL(s).pathname; } catch { /* そのまま */ }
  p = p.split(/[?#]/)[0].replace(/\/+$/, "");
  const last = p.split("/").filter(Boolean).pop();
  return last ? last.toLowerCase() : null;
}

/** 環境変数と既定値から、予約枠 → 種類 の対応表を作る */
export function timerexCalendarMap(env = process.env) {
  const map = {};
  const put = (k, kind) => { const key = calendarKey(k); if (key && TIMEREX_KINDS.includes(kind)) map[key] = kind; };
  for (const [k, kind] of Object.entries(DEFAULT_CALENDARS)) put(k, kind);
  if (env.TIMEREX_CASUAL_INTERVIEW_URL) put(env.TIMEREX_CASUAL_INTERVIEW_URL, "casual");
  if (env.TIMEREX_CEO_INTERVIEW_URL) put(env.TIMEREX_CEO_INTERVIEW_URL, "ceo");
  if (env.TIMEREX_HR_CALENDARS) {
    try {
      const j = JSON.parse(env.TIMEREX_HR_CALENDARS);
      if (j && typeof j === "object") for (const [k, kind] of Object.entries(j)) put(k, kind);
    } catch { /* 読めない設定は無視する（既定と URL 由来の対応だけで動く） */ }
  }
  return map;
}

/** @returns {"casual"|"ceo"|null} 知らない予約枠なら null（呼び出し側で止める） */
export function kindForCalendar(pathOrUrl, env = process.env) {
  const key = calendarKey(pathOrUrl);
  return key ? timerexCalendarMap(env)[key] || null : null;
}
