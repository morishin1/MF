// 退職者（left）を、サーバー側で止めるための共通の判定。
//
// ■ なぜ要るか
//   これまで「退職」の制限は、画面（js/layout.js）の転送だけだった。
//   サーバーも DB も在籍状態（gw_employees.status）を見ないので、
//   内部ロールが残っている退職者は、API を直接呼べば HR・Sales・Office・経営に入れた。
//
// ■ 方針
//   ・権限の行（gw_role_grants / gw_app_grants）は消さない（履歴・監査・再雇用時の確認に使う）
//   ・退職者（left）は、行が残っていても「権限なし」として扱う。行が残っていることで、入れる状態に戻らない
//   ・止める場所は3つ（どれか1つが抜けても、他で止まる）
//       1. lib/auth.js requireUser … ほぼ全部の API の入口
//       2. lib/gw.js gwContext     … 権限の判定の土台
//       3. DB（db/120_left_gate.sql）… 画面を通らず Supabase を直接呼ばれたとき
//
// ■ 「退職」の意味（leaving と left）
//   active   在籍中
//   leaving  退職予定・引継ぎ中。退職日までは通常どおり使える
//   left     退職日を過ぎた／管理者が退職を確定した。通常の画面・API は使えない（退職者ポータルだけ）
//
//   leaving のまま退職日（left_on）を過ぎた人は、翌日 0 時（日本時間）から left として扱う。
//   status が left に書き換わるのを待たない（cron が回る前でも止まる。api/cron/leave.js が後から status を揃える）

import { ymd } from "./jst.js";

/** status が「退職」そのもの */
export const LEFT_STATUS = "left";

/** 退職予定・引継ぎ中 */
export const LEAVING_STATUS = "leaving";

/**
 * その人は、いま退職者として扱うか（日本時間の today で判定）。
 * @param {{status?:string, left_on?:string|null}|null|undefined} employee gw_employees の行
 * @param {string} [today] YYYY-MM-DD（日本時間）
 */
export function isLeftEmployee(employee, today = ymd()) {
  if (!employee) return false;
  if (employee.status === LEFT_STATUS) return true;
  if (employee.status === LEAVING_STATUS && employee.left_on) {
    // 退職日の当日までは通常どおり使える。翌日から止まる
    return String(employee.left_on).slice(0, 10) < today;
  }
  return false;
}

/** 退職者に見せる、本人についての最小の情報（名簿の他の列は渡さない） */
export const leftSelf = (employee) => ({
  id: employee?.id || null,
  display_name: employee?.display_name || null,
  status: LEFT_STATUS,
  left_on: employee?.left_on || null,
});

/** 退職者に返すエラー（HTTP 403） */
export const ACCOUNT_LEFT = {
  error: "account_left",
  hint: "退職済みのため、この画面は使えません。退職後のお手続きは、退職者ページから開いてください",
};
