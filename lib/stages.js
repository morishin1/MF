// 在籍の段階と、その段階で使える画面。
//
// ■ アカウントのマスターは mf.8grp.co.jp
//   ここで登録すると Supabase Auth（auth.users）に1つだけアカウントを作り、
//   そこから無限道場（profiles）・タイムカード（tc_profiles）・
//   会計（memberships）へ配る。
//   無限道場で先に作ってもらう運用にはしない。本人が自分で登録して
//   承認待ちになり、管理者の手数がむしろ増えるため。
//
//   ID とパスワードは auth.users の1組だけ。
//   各システムはその id を主キーに持つだけで、別のパスワードは持たせない。
//
// ■ 段階で画面を出し分ける理由
//   入社日前の人に日報や申請の画面を見せても、書くものが無い。
//   「押していいのか分からないもの」が並んでいると、
//   本当にやってほしいこと（入社手続きと無限道場）が埋もれる。
//
//   入社日が来たら自動で開く。管理者が切り替える操作は要らない。
//   切り替えを人の作業にすると、必ず忘れられて初日に何も使えない人が出る。
//
// ■ 管理者かどうかは、段階とは別の軸
//   段階は「在籍のどこにいるか」（gw_employees.status）。
//   管理者かどうかは社内ロール（gw_role_grants）。
//   管理者は管理画面の並びになるので、この表は使わない。

/** gw_employees.status → 段階 */
export const STAGES = [
  {
    key: "preparing", status: "invited", label: "入社準備",
    note: "入社日まで。入社手続きと無限道場だけが開いています",
  },
  {
    key: "member", status: "active", label: "メンバー",
    note: "すべての画面が使えます",
  },
  {
    key: "leaving", status: "leaving", label: "退職手続き中",
    note: "退職手続きが終わるまで、通常の画面も使えます",
  },
  {
    key: "left", status: "left", label: "退職",
    note: "記録の閲覧だけ。日々の画面は閉じています",
  },
];

const BY_STATUS = new Map(STAGES.map((s) => [s.status, s]));

/** すべての画面の鍵。js/layout.js のメニューと同じ名前を使う */
export const SCREENS = [
  "home", "tasks", "nippo", "schedule", "messages", "workflow",
  "info", "notices", "library", "directory", "mypage",
  // 別システム。同じ auth.users を使うので、別のIDもパスワードも要らない
  "dojo", "timecard",
  "onboarding", "booking", "docs", "menu", "help",
];

/**
 * 段階ごとに開いている画面。
 *
 * 入社準備 … ホーム / やること / 無限道場 / 入社手続き / マイページ
 *            （手続きと学習に集中してもらう）
 * メンバー … 全部。グループウェア・無限道場・タイムカードの3つが使える。
 *            会計は別で、経理・管理担当だけに出す（js/layout.js の shows）
 * 退職手続き中 … メンバーと同じ。引き継ぎの最中に画面を閉じない
 * 退職 … 自分の記録だけ
 */
export const ALLOWED = {
  // 入社準備にタイムカードは出さない。まだ打刻する日が来ていない。
  // 入社日になると status が active になり、そこで出るようになる
  preparing: ["home", "tasks", "dojo", "onboarding", "mypage", "menu", "help"],
  member: SCREENS,
  leaving: SCREENS,
  left: ["home", "mypage", "menu", "help"],
};

/** 入社準備のあいだだけ出す画面。入社後はメニューから消える */
export const PREPARING_ONLY = ["onboarding"];

/**
 * その人がいまどの段階か。
 * @param {object} employee gw_employees の行
 */
export const stageOf = (employee) =>
  BY_STATUS.get(employee?.status) || BY_STATUS.get("active");

/** その段階でその画面を開けるか */
export const canOpen = (stageKey, screen) =>
  (ALLOWED[stageKey] || ALLOWED.member).includes(screen);

/**
 * 入社日が来ているか。
 *
 * 「入社準備」から「メンバー」へ自動で開くための判定。
 * 日本時間で見る。サーバは UTC で動いているので、
 * ここを間違えると初日の朝に開かない人が出る。
 *
 * @param {object} employee gw_employees の行
 * @param {string} today    YYYY-MM-DD（日本時間）
 */
export function shouldOpen(employee, today) {
  if (!employee || employee.status !== "invited") return false;
  // 入社日が入っていない人は、勝手に開けない。
  // いつ入るか決まっていない人を在籍にしてしまうと、名簿の人数が狂う
  if (!employee.joined_on) return false;
  return String(employee.joined_on) <= today;
}

/**
 * 入社手続きの提出が全部そろったか。
 *
 * 見るのは「本人が担当で、必須の項目」だけ。
 *   本人フォーム（個人情報・口座・緊急連絡先）
 *   3書類の確認
 *   必須の提出書類
 * 会社側・社労士側の項目は含めない。本人が待たされる理由にならない。
 *
 * 任意の書類（年金手帳など）は「ありません」で na にできるので、
 * 出せないものがあっても止まらない。
 *
 * @param {object[]} items gw_procedure_items の行
 */
export function onboardingDone(items) {
  const mine = (items || []).filter((i) => i.owner === "employee" && i.required);
  if (!mine.length) return false;
  return mine.every((i) => i.status === "submitted" || i.status === "done" || i.status === "na");
}

/**
 * 画面に渡す形。
 *
 * ■ 提出がそろったら、入社日を待たずに画面を開く
 *   やることが終わっているのに閉じたままだと、
 *   「まだ何か残っているのか」と本人が探すことになる。
 *
 * ■ ただし在籍の状態（status）は入社日まで変えない
 *   status を先に active にすると、名簿の人数・日報の対象者・
 *   KPIの集計に、まだ働いていない人が混ざる。
 *   開けるのは画面だけにして、在籍の扱いは入社日で切り替える。
 *
 * @param {object} employee gw_employees の行
 * @param {{onboardingDone?:boolean}} opts
 */
export const stageInfo = (employee, opts = {}) => {
  const s = stageOf(employee);
  const unlocked = s.key === "preparing" && !!opts.onboardingDone;
  return {
    key: s.key,
    label: s.label,
    note: unlocked ? "入社手続きが終わりました。ひととおりの画面が使えます" : s.note,
    allowed: unlocked ? SCREENS : (ALLOWED[s.key] || ALLOWED.member),
    // 入社準備のあいだだけ出すもの。入社後は消える
    preparingOnly: s.key === "preparing" ? PREPARING_ONLY : [],
    // 手続きが済んで開いた状態か。画面の案内の出し分けに使う
    unlocked,
  };
};
