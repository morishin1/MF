// 毎日の実行管理。「明日の重要タスク」から「今日やる3つ」まで。
//
// ■ 何のための仕組みか
//
//   タスクをたくさん登録することではなく、毎日終えることを目的にする。
//   一覧は増える一方だが、1日に終えられる数は変わらない。
//   だから「明日はこれ」を先に決めて、そこだけを追う。
//
//     明日の重要タスクを決める（1〜3件） → 日報 → 翌朝へ引き継ぐ
//
// ■ 日報を絶対にブロックしない（日報提出ハードロック修正）
//
//   以前は「明日の3件が確定するまで日報が書けない」ようにしていたが、
//   実際には「タスク入力欄が見当たらず、日報を提出できなかった」という
//   運用事故を起こした。明日のタスクが 0件／1件／2件／未確定 でも、
//   今日の日報は必ず書ける・提出できる。nippoGate() は常に open:true を返す。
//   「明日やることが決まっていない」は警告にはしても、提出の必須条件にはしない。
//
// ■ 3件ぴったりは要求しない
//
//   仕事が少ない日・短時間勤務・休日前もあるため、1〜3件で確定できる。
//   0件でもよい（そのときは日報側で軽い注意を出すだけ）。
//
// ■ 判定はここ1か所
//
//   画面・API・cron の3か所で「確定したか」を書くと、必ず食い違う。
//   この関数だけが、状態と「次に何をするか」を決める。

import { isBizDay } from "./holidays.js";

/** 1日に決める重要タスクの数。1件以上、これより多くは決めさせない */
export const MIN_FOCUS = 1;
export const MAX_FOCUS = 3;

/** 日ごとの状態 */
export const FOCUS_STATES = [
  { key: "draft",      label: "登録中",     todo: "明日の重要タスクを1〜3件決める" },
  { key: "ready",      label: "AI確認待ち", todo: "AIに内容を見てもらう" },
  { key: "ai_checked", label: "確認待ち",   todo: "AIの指摘を見て、確定する" },
  { key: "confirmed",  label: "確定",       todo: "" },
];
export const FOCUS_STATE_KEYS = FOCUS_STATES.map((s) => s.key);
export const stateOf = (key) => FOCUS_STATES.find((s) => s.key === key) || FOCUS_STATES[0];

/** 重要タスクに要るもの。ここが欠けていると、夜に できた／できなかった を判定できない */
export const FOCUS_FIELDS = [
  { key: "title",          label: "タスク名",   required: true },
  { key: "purpose",        label: "目的",       required: true },
  { key: "done_condition", label: "完了条件",   required: true },
  { key: "assignee_id",    label: "担当者",     required: true },
  { key: "due_on",         label: "期限",       required: true },
  { key: "priority",       label: "優先度",     required: true },
  { key: "kpi_link",       label: "関連KPI・事業", required: false },
];

/** 未完了をどうするか。自動では決めない。4つから人が選ぶ */
export const CARRY_CHOICES = [
  { key: "carry",  label: "明日へ持ち越す", hint: "同じ内容で、明日の重要タスクにする" },
  { key: "lower",  label: "優先度を下げる", hint: "重要タスクから外して、ふつうのタスクに戻す" },
  { key: "hand",   label: "別の人へ渡す",   hint: "担当を変えて、その人のタスクにする" },
  { key: "drop",   label: "やらないことにする", hint: "取りやめる。理由は記録に残る" },
];
export const CARRY_KEYS = CARRY_CHOICES.map((c) => c.key);

/** 何度も持ち越されているタスクは、そもそもやらない判断が要る */
export const CARRY_WARN = 3;

/**
 * ペアコーチング（3人一組の対話で、タスクの質を上げる）
 *
 * ゴールは承認ではない。「候補者を10名探す」のような作業だけの書き方を、
 * 聞き役との対話で「何を得たいか」「なぜ明日やるか」「どこまでできたら
 * 完了か」まで深掘りする。決めるのは常に本人。AIは質問候補の提案・
 * 抽象的な表現の指摘くらいの補助にとどめ、判定・変更はしない
 */
export const COACH_STEPS = [
  { key: "echo",     label: "オウム返し" },
  { key: "purpose",  label: "目的確認" },
  { key: "outcome",  label: "成果確認" },
  { key: "reason",   label: "明日やる理由" },
  { key: "done",     label: "完了条件確認" },
  { key: "edit",     label: "本人がタスクを修正" },
  { key: "confirm",  label: "確認済み" },
];

export const COACH_QUESTIONS = [
  "このタスクで何を得たい？",
  "それができると何が前に進む？",
  "なぜ明日やる必要がある？",
  "数字や状態で表すとどうなれば成果？",
  "どこまでできたら完了？",
];

/** 画面に出す、オウム返しのやりとり例 */
export const COACH_ECHO_EXAMPLE = [
  { who: "本人", text: "候補者を10名探します" },
  { who: "コーチ", text: "候補者を10名探すんですね" },
  { who: "コーチ", text: "それによって何を得たいですか？" },
  { who: "本人", text: "面談候補を3名つくりたいです" },
  { who: "コーチ", text: "面談候補3名をつくることが成果なんですね" },
  { who: "コーチ", text: "では完了条件は何ですか？" },
];

/** タスクの質。4段階。目標はLv3以上（成果が明確） */
export const QUALITY_LEVELS = [
  { key: 1, label: "作業だけ" },
  { key: 2, label: "目的あり" },
  { key: 3, label: "成果が明確" },
  { key: 4, label: "成果＋完了条件が明確" },
];
export const qualityLabel = (n) => QUALITY_LEVELS.find((q) => q.key === n)?.label || "";

/**
 * 今の記入内容から、タスクの質を判定する。
 *
 * AIが勝手に判定するのではなく、埋まっている項目から機械的に決まるだけ。
 * 埋めるかどうか（＝レベルを上げるかどうか）は、対話の中で本人が決める
 */
export function qualityLevel(t) {
  const has = (v) => v !== null && v !== undefined && String(v).trim() !== "";
  if (!has(t?.purpose)) return 1;
  if (!has(t?.outcome)) return 2;
  if (!has(t?.done_condition ?? t?.doneCondition)) return 3;
  return 4;
}

/** 終わったものか */
export const isDone = (t) => t.status === "done";
const isOpen = (t) => t.status === "todo" || t.status === "doing";

/**
 * 重要タスクとして、欠けている項目。
 * 画面はこれを見て「あと2つ入れてください」と出す
 */
export function missingFields(t) {
  return FOCUS_FIELDS.filter((f) => f.required)
    .filter((f) => {
      const v = t?.[f.key];
      return v === null || v === undefined || String(v).trim() === "";
    })
    .map((f) => ({ key: f.key, label: f.label }));
}

/**
 * その日の状態と、次に何をすればよいか。
 *
 * @param {object} p
 *   day    gw_focus_days の行（無ければ null）
 *   tasks  その日の重要タスク（gw_tasks の行）
 * @returns {{key, label, todo, count, ready, incomplete:Array, confirmed:boolean}}
 */
export function focusState({ day, tasks = [] } = {}) {
  const live = tasks.filter((t) => t.status !== "cancelled");
  const incomplete = live.filter((t) => missingFields(t).length);
  const enough = live.length >= MIN_FOCUS;
  const stored = day?.status || "draft";
  // ペアコーチングを終えたか。承認フローではないので、AI確認とは別に持つ
  // （AIに見てもらう・は st.ready のままでよい。塞ぐのは確定だけ）
  const coached = live.length > 0 && live.every((t) => t.coached_at);

  // 確定したあとで件数が減った・項目が欠けたときは、確定を保つ。
  // 確定を取り消すと、日報が書けなくなって手が止まる
  if (stored === "confirmed") {
    const s = stateOf("confirmed");
    return { key: "confirmed", label: s.label, todo: "", count: live.length,
             ready: true, incomplete, confirmed: true, coached: true };
  }
  // AIが見た結果は残っているが、そのあとで件数が減った → 見直しから
  const key = !enough || incomplete.length ? "draft"
    : stored === "ai_checked" ? "ai_checked" : "ready";
  const s = stateOf(key);
  const ready = enough && !incomplete.length;
  return {
    key, label: s.label, count: live.length, ready,
    incomplete, confirmed: false, coached,
    todo: key === "draft"
      ? (!enough ? `あと ${MIN_FOCUS - live.length} 件、明日やることを決めてください`
                 : `${incomplete.length} 件に足りない項目があります`)
      : ready && !coached ? `${live.length}件のペアコーチングを終えてください`
      : s.todo,
  };
}

/**
 * 今日の進み具合。「1 / 3 完了」。
 * 分母は、その日に決めた重要タスクの数（取りやめたものは除く）
 */
export function progressOf(tasks = []) {
  const live = tasks.filter((t) => t.status !== "cancelled");
  const done = live.filter(isDone).length;
  return {
    done, total: live.length,
    label: `${done} / ${live.length}`,
    allDone: live.length > 0 && done === live.length,
    pct: live.length ? Math.round((done / live.length) * 100) : 0,
  };
}

/**
 * 明日＝次の営業日。
 *
 * 金曜の夜に「明日の3件」を決めると、土曜のタスクになってしまう。
 * 土日祝を飛ばして、次に働く日にする
 */
export function nextFocusDate(today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(today || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  for (let i = 0; i < 14; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBizDay(d)) return d.toISOString().slice(0, 10);
  }
  return null;
}

/** 日本時間の今日 */
export const jstToday = (offsetDays = 0) =>
  new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);

/**
 * 日報を書いてよいか。
 *
 * 常に open:true（日報提出ハードロック修正）。明日のタスクが
 * 0件／未確定でも日報は止めない。count/confirmed は、画面が
 * 軽い注意を出すための材料としてだけ使う
 */
export function nippoGate({ day, tasks, focusDate }) {
  const st = focusState({ day, tasks });
  if (st.confirmed) {
    return { open: true, focusDate, count: st.count, confirmed: true,
             hint: "明日のタスクが確定しました。今日の日報を入力してください" };
  }
  if (st.count > 0) {
    return { open: true, focusDate, count: st.count, confirmed: false,
             hint: `${focusDate ? `${focusDate} の` : "明日の"}重要タスクは、まだ確定していません（${st.todo}）` };
  }
  return {
    open: true, focusDate, count: 0, confirmed: false,
    hint: "明日やることがまだ決まっていません",
  };
}

/**
 * 管理者の一覧に出す1行。
 *
 *   誰が／今日の3件と完了数／明日の3件の状態／いま止まっているか
 *
 * @param {object} p { employee, today:{day,tasks}, tomorrow:{day,tasks} }
 */
export function boardRow({ employee, today, tomorrow }) {
  const t = progressOf(today?.tasks || []);
  const tm = focusState({ day: tomorrow?.day, tasks: tomorrow?.tasks || [] });
  const todayState = focusState({ day: today?.day, tasks: today?.tasks || [] });

  // 状態は3つだけ。細かく分けると、一覧を見て「で、誰を見ればいいのか」が分からなくなる
  //   done    … 今日ぶんが全部終わり、明日ぶんも確定している
  //   warn    … 明日ぶんが未登録、または今日ぶんに手が付いていない
  //   working … それ以外（進行中）
  const state = t.allDone && tm.confirmed ? "done"
    : (!tomorrow?.tasks?.length || (t.total > 0 && t.done === 0)) ? "warn"
      : "working";

  return {
    employeeId: employee.id,
    name: employee.display_name,
    department: employee.department || null,
    today: { count: t.total, done: t.done, label: t.label, allDone: t.allDone,
             confirmed: todayState.confirmed },
    tomorrow: { count: tm.count, state: tm.key, label: tm.label, confirmed: tm.confirmed },
    state,
    stateLabel: state === "done" ? "完了" : state === "warn" ? "注意" : "進行中",
    // 何が止まっているか。1行だけ
    stuck: state === "done" ? ""
      : !tomorrow?.tasks?.length ? "明日のタスクが未登録"
        : !tm.confirmed ? `明日のタスクが${tm.label}`
          : t.total === 0 ? "今日のタスクが未登録"
            : t.done === 0 ? "今日のタスクに手が付いていません"
              : `今日 ${t.label}`,
  };
}

/** 一覧の上に出す数。誰が止まっているかだけ分かればよい */
export function boardSummary(rows = []) {
  return {
    people: rows.length,
    doneAll: rows.filter((r) => r.today.allDone).length,
    noTomorrow: rows.filter((r) => !r.tomorrow.count).length,
    waiting: rows.filter((r) => r.tomorrow.count && !r.tomorrow.confirmed).length,
    warn: rows.filter((r) => r.state === "warn").length,
  };
}
