// タスクの「依頼 → 受諾 → 完了」と、「繰り返し」。
//
// ■ 旧タスク管理（8grp.co.jp/8/zimu/task/）から移した仕組み
//
//   向こうで効いていたのは、一覧でも通知でもなく、この2つだった。
//
//   ① 頼みっぱなしにしない
//
//      「自分で上げておいて」は漏れる。頼んだ人がその場で登録する。
//      ただし登録しただけでは仕事になっていない。
//      担当者が期限と完了条件を見て「受けた」と押してはじめて、
//      両者の認識が同じになる。
//      受けていない依頼は、一覧で目立たせる。放っておけないように。
//
//   ② 終わったことを、終わったと書く
//
//      完了を押すだけだと、何をしたのかが残らない。
//      頼んだ人は結局チャットで「どうなりました？」と聞くことになり、
//      タスク管理の外でやりとりが起きる。
//      完了のときに結果を1行書かせる。頼んだ人はそれを読めば済む。
//
//   ③ 決まった日に必ず出る
//
//      月次の締め・支払・提出は、覚えている人が覚えているうちは回るが、
//      その人が休むと止まる。繰り返しの「元」を1つ置いて、
//      そこから日付ぶんを自動で作る。
//
// ■ 判定はここ1か所
//
//   画面とAPIの両方で「受諾待ちかどうか」を書くと、必ず食い違う。

import { isBizDay, bizDaysOfMonth, domDate, dateStr, daysInMonth, ymAdd }
  from "./holidays.js";

/** 繰り返しの型 */
export const RECUR_TYPES = [
  { key: "daily",  label: "毎日" },
  { key: "weekly", label: "毎週" },
  { key: "dom",    label: "毎月（日にち）" },
  { key: "biz",    label: "毎月（第n営業日）" },
];

export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 休みに当たったときの寄せ方 */
export const ADJUSTS = [
  { key: "",     label: "そのまま" },
  { key: "prev", label: "前の営業日" },
  { key: "next", label: "次の営業日" },
];

/**
 * 繰り返しの「元」を、人が読める1行にする。
 * 一覧に出すので、設定を開かなくても何の繰り返しか分かるように
 */
export function recurLabel(r) {
  if (!r || !r.type) return "";
  if (r.type === "daily") return r.daily === "wd" ? "毎日（平日）" : "毎日";
  if (r.type === "weekly") return `毎週 ${WEEKDAYS[r.weekday ?? 1]}曜`;
  if (r.type === "dom") {
    const adj = r.adj === "prev" ? "（休みなら前営業日）"
      : r.adj === "next" ? "（休みなら次営業日）" : "";
    return `毎月 ${r.n || 1}日${adj}`;
  }
  if (r.type === "biz") return `毎月 第${r.n || 1}営業日`;
  return "";
}

/**
 * 繰り返しの決まりが、使える形かどうか。
 *
 * 画面から来たものをそのまま jsonb に入れると、
 * 「type だけあって n が無い」ような行ができて、
 * 生成のたびに静かに1件も作られない、が起きる。
 *
 * @returns {{ok:true, recur:object}|{ok:false, why:string}}
 */
export function cleanRecur(raw) {
  if (!raw || !raw.type) return { ok: false, why: "繰り返しの種類を選んでください" };
  const type = String(raw.type);
  if (!RECUR_TYPES.some((t) => t.key === type)) {
    return { ok: false, why: "繰り返しの種類が正しくありません" };
  }
  if (type === "daily") {
    return { ok: true, recur: { type, daily: raw.daily === "all" ? "all" : "wd" } };
  }
  if (type === "weekly") {
    const w = Number(raw.weekday);
    if (!Number.isInteger(w) || w < 0 || w > 6) {
      return { ok: false, why: "曜日を選んでください" };
    }
    return { ok: true, recur: { type, weekday: w } };
  }
  const n = Number(raw.n);
  if (type === "dom") {
    if (!Number.isInteger(n) || n < 1 || n > 31) {
      return { ok: false, why: "日にちは 1〜31 で入れてください" };
    }
    const adj = ["prev", "next"].includes(raw.adj) ? raw.adj : "";
    return { ok: true, recur: { type, n, adj } };
  }
  // biz
  if (!Number.isInteger(n) || n < 1 || n > 23) {
    return { ok: false, why: "第n営業日の n は 1〜23 で入れてください" };
  }
  return { ok: true, recur: { type, n } };
}

/**
 * 繰り返しの決まりから、その期間に当たる日付を並べる。
 *
 * @param {object} r      繰り返しの決まり（cleanRecur を通したもの）
 * @param {string} fromYm YYYY-MM（この月の1日から）
 * @param {string} toYm   YYYY-MM（この月の末日まで）
 * @returns {string[]} YYYY-MM-DD の並び
 */
export function occurrenceDates(r, fromYm, toYm) {
  const out = [];
  if (!r || !r.type) return out;

  if (r.type === "daily") {
    const [fy, fm] = fromYm.split("-").map(Number);
    const d = new Date(Date.UTC(fy, fm - 1, 1));
    const [ty, tm] = toYm.split("-").map(Number);
    const end = new Date(Date.UTC(ty, tm, 0));
    for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (r.daily === "wd" && !isBizDay(d)) continue;
      out.push(dateStr(d));
    }
    return out;
  }

  let ym = fromYm;
  // 月をまたいで進む。toYm を含める
  while (ym <= toYm) {
    if (r.type === "biz") {
      const biz = bizDaysOfMonth(ym);
      // 第n営業日がその月に無ければ、その月の最後の営業日に寄せる。
      // 「第23営業日」を作れない月で、静かに1件も出ないほうが困る
      if (biz.length) out.push(dateStr(biz[Math.min((r.n || 1) - 1, biz.length - 1)]));
    } else if (r.type === "dom") {
      out.push(domDate(ym, r.n || 1, r.adj || ""));
    } else if (r.type === "weekly") {
      const [y, m] = ym.split("-").map(Number);
      for (let dd = 1; dd <= daysInMonth(ym); dd++) {
        const d = new Date(Date.UTC(y, m - 1, dd));
        if (d.getUTCDay() === (r.weekday ?? 1)) out.push(dateStr(d));
      }
    }
    ym = ymAdd(ym, 1);
  }
  return out;
}

/**
 * 先に作っておく月数。
 *
 * ■ なぜ2か月なのか
 *
 *   旧は12か月先まで先に作っていた。
 *   すると月1件の繰り返しでも、担当者の画面に「未確認の依頼」が12件並び、
 *   片付けても減らない＝終わらない、という見え方になっていた。
 *
 *   当月＋翌月だけ作る。翌月ぶんも作るのは、
 *   月初に誰も画面を開かなくても、1日ぶんのタスクが必ず在るようにするため。
 */
export const HORIZON_MONTHS = 2;

/** その繰り返しの「元」から、まだ作っていない回を出す */
export function pendingOccurrences(template, { today, have = new Set() }) {
  const ym = today.slice(0, 7);
  const dates = occurrenceDates(template.recur, ym, ymAdd(ym, HORIZON_MONTHS - 1));
  return dates
    .filter((ds) => ds >= today)                 // 過ぎた日は作らない
    .map((ds) => ({ date: ds, key: `${template.id}|${ds}` }))
    .filter((o) => !have.has(o.key));
}

// ---- 依頼 → 受諾 → 完了 -------------------------------------------------------

/**
 * そのタスクが、いまどの段になっているか。
 *
 *   waiting  … 頼まれたが、担当者がまだ受けていない
 *   doing    … 受けて、やっている
 *   done     … 終わった
 *   own      … 自分で立てたもの（頼んだ人＝担当者）。受諾は要らない
 *
 * ■ 自分で立てたものに「受けますか」と聞かない
 *
 *   自分が自分に頼んだものまで受諾待ちにすると、
 *   一覧の大半が「未確認」で埋まって、本当に見てほしい依頼が埋もれる。
 */
export function flowState(t) {
  if (t.status === "done" || t.status === "cancelled") {
    return { key: "done", label: "完了" };
  }
  if (!t.requestedByOther) return { key: "own", label: "" };
  if (!t.accepted_at && !t.acceptedAt) {
    return { key: "waiting", label: "未確認の依頼" };
  }
  return { key: "doing", label: "" };
}

/**
 * 受諾されていない依頼か。一覧で目立たせるのはこれだけ。
 * 「自分が頼まれたもの」かつ「まだ受けていない」かつ「終わっていない」
 */
export function needsAccept(t) {
  return flowState(t).key === "waiting";
}

/**
 * 完了にしてよいか。
 *
 * ■ 結果を書かせるのは、頼まれた仕事だけ
 *
 *   自分のメモまで「結果を書け」と言われると、
 *   書くのが面倒で完了を押さなくなる。そうなると一覧が信用できなくなる。
 *   頼んだ人がいる仕事だけ、その人に読ませるために書いてもらう。
 *
 * @returns {{ok:true}|{ok:false, why:string}}
 */
export function canComplete(t, result) {
  const text = String(result || "").trim();
  if (t.requestedByOther && !text) {
    return { ok: false, why: "何をしたかを1行書いてください（依頼した人が読みます）" };
  }
  return { ok: true };
}
