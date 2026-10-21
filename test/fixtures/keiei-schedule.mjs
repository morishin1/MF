// 経営「予定・日報確認」のテスト材料（架空の人・架空の予定）。test/keieischeduleapi.mjs と test/ui/keieischeduleui.mjs が使う。
//
// 今日 2026-10-09（金）。翌営業日は 10-13（火）：10-10 土・10-11 日・10-12 月（スポーツの日）を飛ばす
//   中村（e1）… 今日の日報 提出。翌営業日に業務予定2件（10:00-11:00 訪問・10:30-11:30 会議＝重なり）。
//              私用・予約・他社の行も持つ（数えない）。訪問のメモ（body）は返さない
//   藤本（e2）… 今日の日報 下書きのまま（submitted_at なし＝未提出）。翌営業日は私用だけ＝未登録
//   山内（e3）… 今日の日報 提出。翌営業日 10-13〜14 は休暇（source=leave、1行で2日）
//   今福（e4）… 10-13 入社（今日は入社前＝対象外）。翌営業日に業務予定1件
//   退職予定（e5）… 10-12 退職（今日は対象・日報提出。翌営業日は退職後＝対象外）
//   ほか … 退職済み（left）・ログインなし・他社 は出ない
export const TENANT = "00000000-0000-4000-8000-0000000000f1";
export const OTHER = "00000000-0000-4000-8000-0000000000f2";
export const TODAY = "2026-10-09";
export const NEXT = "2026-10-13";
export const NOW_ISO = "2026-10-09T03:00:00Z";   // 日本時間 12:00
export const SECRET = "秘密メモ：先方の携帯 090-0000-0000";

const emp = (id, user, name, extra = {}) => ({
  id, tenant_id: TENANT, user_id: user, display_name: name, department: "営業", status: "active", joined_on: "2024-04-01", left_on: null, ...extra,
});
const ev = (id, employee, startZ, endZ, extra = {}) => ({
  id, tenant_id: TENANT, employee_id: employee, title: "打合せ", body: null, location: null, category: "work", all_day: false,
  starts_at: startZ, ends_at: endZ, visibility: "shared", source: "self", source_id: null,
  created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z", ...extra,
});
const nippo = (user, date, extra = {}) => ({ id: `n-${user}-${date}`, user_id: user, work_date: date, submitted_at: `${date}T09:00:00Z`, top_priority: "提案書", ...extra });

export function scheduleRows() {
  return {
    gw_employees: [
      emp("e1", "u1", "中村 テスト"),
      emp("e2", "u2", "藤本 テスト", { department: "開発" }),
      emp("e3", "u3", "山内 テスト"),
      emp("e4", "u4", "今福 テスト", { joined_on: NEXT }),
      emp("e5", "u5", "退職予定 テスト", { status: "leaving", left_on: "2026-10-12" }),
      emp("e6", "u6", "退職済み テスト", { status: "left", left_on: "2026-09-30" }),
      emp("e7", null, "ログインなし テスト"),
      { ...emp("x1", "ux", "他社 テスト"), tenant_id: OTHER },
    ],
    tc_nippo: [
      nippo("u1", TODAY), nippo("u3", TODAY), nippo("u5", TODAY),
      nippo("u2", TODAY, { submitted_at: null }),       // 下書き（朝の入力だけ）は提出と数えない
      nippo("u1", "2026-10-08"), nippo("u2", "2026-10-08"),
      nippo("ux", TODAY),
    ],
    gw_calendar_events: [
      // 中村：翌営業日 10:00-11:00 訪問（メモあり）・10:30-11:30 会議（重なる）
      ev("ev-n1", "e1", "2026-10-13T01:00:00Z", "2026-10-13T02:00:00Z", { title: "A社 企業訪問", category: "visit", location: "大阪市", body: SECRET }),
      ev("ev-n2", "e1", "2026-10-13T01:30:00Z", "2026-10-13T02:30:00Z", { title: "週次会議", category: "meeting" }),
      ev("ev-n3", "e1", "2026-10-13T05:00:00Z", "2026-10-13T06:00:00Z", { title: "歯医者", category: "private" }),
      ev("ev-n4", "e1", "2026-10-13T06:00:00Z", "2026-10-13T07:00:00Z", { title: "会議室予約", source: "booking", source_id: "b1" }),
      ev("ev-n5", "e1", "2026-10-07T00:00:00Z", "2026-10-07T01:00:00Z", { title: "朝会" }),
      ev("ev-n6", "e1", "2026-10-13T03:00:00Z", "2026-10-13T03:00:00Z", { title: "時刻が不正" }),
      ev("ev-n7", "e1", "2026-10-13T04:00:00Z", "2026-10-13T05:00:00Z", { title: "  " }),
      // 他社の行（社員IDが同じでも出さない）
      { ...ev("ev-x1", "e1", "2026-10-13T01:00:00Z", "2026-10-13T02:00:00Z", { title: "他社の予定" }), tenant_id: OTHER },
      ev("ev-x2", "x1", "2026-10-13T01:00:00Z", "2026-10-13T02:00:00Z", { title: "他社の人の予定", tenant_id: OTHER }),
      // 藤本：翌営業日は私用だけ
      ev("ev-f1", "e2", "2026-10-13T01:00:00Z", "2026-10-13T02:00:00Z", { title: "通院", category: "private" }),
      // 山内：休暇（10-13 0:00〜10-14 23:59 日本時間。1行で2日）
      ev("ev-y1", "e3", "2026-10-12T15:00:00Z", "2026-10-14T14:59:00Z", { title: "山内 テストさん 休暇", category: "other", all_day: true, source: "leave", source_id: "rq1" }),
      // 今福：入社日に1件
      ev("ev-i1", "e4", "2026-10-13T00:00:00Z", "2026-10-13T08:00:00Z", { title: "入社オリエンテーション", category: "meeting" }),
    ],
  };
}
