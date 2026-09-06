// 1日3回の声かけ。いつ送るかを決める。
//
// ■ 監視ではなく、リズムを作るためのもの
//     ゴールを決める → 動く → 途中で見る → 日報 → AI → 翌日の最初の一手
//   この形が身につくまでのあいだ、区切りで声をかける。
//   「まだやっていない人」を探すための仕組みにはしない。
//   だから、済んでいる人には送らない（api/cron/reminders.js）。
//
// ■ 時刻は勤務時間から決める
//   9時〜18時で固定すると、短時間勤務の人には合わない。
//   13時〜17時の人に9時の通知が飛ぶと、その通知はただの雑音になる。
//
//     始業           … 今日のゴールを決める
//     勤務のまんなか … KPIの途中確認（見るだけ）
//     終業の15分前   … 日報
//
//   勤務時間は gw_contracts.work_hours に「9:00〜18:00」のような
//   文字で入っている。決まった形式ではないので、読めなければ既定に落とす。
//   本人が時刻を直接決めていれば、そちらが優先。
//
// ■ 15分刻み
//   cron を15分おきに回して、その時刻に合う人へ送る。
//   1分おきに回して正確さを上げても、返ってくるものは変わらない。

/** 勤務時間が読めなかったときの既定 */
export const DEFAULTS = { morning: "09:00", midday: "14:00", evening: "17:45" };

export const SLOTS = [
  {
    key: "morning",
    title: "今日のゴールを決めましょう",
    body: "18時に「今日は良かった」と思えるとしたら、何ができている状態ですか。1分で終わります。",
    url: "/nippo.html#morning",
    tag: "kp-morning",
  },
  {
    key: "midday",
    title: "30秒チェック",
    body: "KPIの進み、朝の予定との差、午後の最優先。見るだけで大丈夫です。",
    url: "/nippo.html#midday",
    tag: "kp-midday",
  },
  {
    key: "evening",
    title: "日報の時間です",
    body: "今日の「デキタ」を3つ。3〜5分で終わります。AIが明日の最初の一手まで返します。",
    url: "/nippo.html#evening",
    tag: "kp-evening",
  },
];

const pad = (n) => String(n).padStart(2, "0");

/** "9:5" → "09:05"。読めなければ null */
function hhmm(h, m) {
  const hh = Number(h), mm = Number(m ?? 0);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) return null;
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null;
  return `${pad(hh)}:${pad(mm)}`;
}

/** HH:MM を分に。読めなければ null */
export function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 24 * 60 ? v : null;
}

/** 分を HH:MM に。15分単位に丸める（切り捨て） */
export function fromMin(v) {
  const q = Math.max(0, Math.min(23 * 60 + 45, Math.floor(v / 15) * 15));
  return `${pad(Math.floor(q / 60))}:${pad(q % 60)}`;
}

/**
 * 勤務時間の文字から始業・終業を取り出す。
 *
 * 読める例:
 *   9:00〜18:00 ／ 9:00～18:00 ／ 9:00-18:00 ／ 09:00 ~ 18:00
 *   10時〜16時 ／ 10:00から16:00まで
 * 「1日8時間」のように時刻が無いものは読めない → null
 */
export function parseWorkHours(text) {
  const s = String(text || "").replace(/\s/g, "");
  if (!s) return null;

  // 9:00〜18:00 の形
  let m = /(\d{1,2}):(\d{2})[^\d]{1,6}?(\d{1,2}):(\d{2})/.exec(s);
  if (m) {
    const start = hhmm(m[1], m[2]), end = hhmm(m[3], m[4]);
    return start && end ? { start, end } : null;
  }
  // 10時〜16時 の形
  m = /(\d{1,2})時[^\d]{1,6}?(\d{1,2})時/.exec(s);
  if (m) {
    const start = hhmm(m[1], 0), end = hhmm(m[2], 0);
    return start && end ? { start, end } : null;
  }
  return null;
}

/**
 * その人の3つの時刻を決める。
 *
 * 優先順位: 本人が決めた時刻 → 勤務時間から自動 → 既定
 *
 * @param {object} prefs      gw_reminder_prefs の行（無くてよい）
 * @param {string} workHours  gw_contracts.work_hours
 * @returns {{morning:string, midday:string, evening:string, source:string}}
 */
export function slotTimes(prefs, workHours) {
  const auto = { ...DEFAULTS };
  let source = "default";

  const w = parseWorkHours(workHours);
  if (w) {
    const s = toMin(w.start), e = toMin(w.end);
    // 終業が始業より前（夜勤など）は自動で決めない。取り違えるより既定のほうがまし
    if (s !== null && e !== null && e - s >= 120) {
      source = "work_hours";
      auto.morning = fromMin(s);
      auto.midday = fromMin(s + (e - s) / 2);
      auto.evening = fromMin(e - 15);
    }
  }

  const pick = (v, fallback) => (toMin(v) !== null ? fromMin(toMin(v)) : fallback);
  return {
    morning: pick(prefs?.morning_at, auto.morning),
    midday: pick(prefs?.midday_at, auto.midday),
    evening: pick(prefs?.evening_at, auto.evening),
    // 本人が1つでも決めていれば「手動」。画面の説明の出し分けに使う
    source: (prefs?.morning_at || prefs?.midday_at || prefs?.evening_at) ? "manual" : source,
  };
}

/** その時刻に送る枠。無ければ null */
export function slotDueAt(prefs, workHours, nowHHMM) {
  const t = slotTimes(prefs, workHours);
  if (prefs?.enabled === false) return null;
  if (t.morning === nowHHMM && prefs?.morning_on !== false) return "morning";
  if (t.midday === nowHHMM && prefs?.midday_on !== false) return "midday";
  if (t.evening === nowHHMM && prefs?.evening_on !== false) return "evening";
  return null;
}

/** 日本時間のいま。{ date:'YYYY-MM-DD', hhmm:'HH:MM'（15分に丸め）, weekday:1..7 } */
export function jstNow(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const date = jst.toISOString().slice(0, 10);
  const min = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  // 0=日 → 7、1..6 はそのまま（1=月）
  const weekday = jst.getUTCDay() === 0 ? 7 : jst.getUTCDay();
  return { date, hhmm: fromMin(min), weekday };
}
