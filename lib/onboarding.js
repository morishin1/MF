// 入社・退職手続きの既定チェックリスト。
//
// 雇用区分ごとに「最初に並ぶ項目」を決めるだけのもの。作成後は画面から
// 自由に増減できるので、ここは運用しながら育てる叩き台という位置づけ。
//
// owner              … 誰の担当か。'employee' の項目だけがメンバー画面に出る
// share_with_advisor … 社労士に開示してよい項目か。既定は開示しない

const DOC = "document", TASK = "task", ACCOUNT = "account", EQUIP = "equipment";

// 社会保険・雇用保険に関わるものは社労士に共有する
const ONBOARDING_COMMON = [
  { title: "履歴書・職務経歴書",           category: DOC,   owner: "employee" },
  { title: "マイナンバー確認書類",         category: DOC,   owner: "employee", share_with_advisor: true },
  { title: "給与振込口座の届出",           category: DOC,   owner: "employee" },
  { title: "扶養控除等申告書",             category: DOC,   owner: "employee", share_with_advisor: true },
  { title: "年金手帳・基礎年金番号",       category: DOC,   owner: "employee", share_with_advisor: true },
  { title: "雇用保険被保険者証",           category: DOC,   owner: "employee", share_with_advisor: true },
  { title: "緊急連絡先の届出",             category: DOC,   owner: "employee" },
  { title: "雇用契約書の締結",             category: DOC,   owner: "hr" },
  { title: "社会保険の資格取得届",         category: TASK,  owner: "labor_advisor", share_with_advisor: true },
  { title: "雇用保険の資格取得届",         category: TASK,  owner: "labor_advisor", share_with_advisor: true },
  { title: "メールアカウントの発行",       category: ACCOUNT, owner: "hr" },
  { title: "グループウェアの招待",         category: ACCOUNT, owner: "hr" },
  { title: "PC・備品の貸与",               category: EQUIP, owner: "hr" },
  { title: "初日の受け入れ準備",           category: TASK,  owner: "hr" },
];

// 業務委託は雇用ではないので社会保険まわりを外す
const ONBOARDING_CONTRACTOR = [
  { title: "業務委託契約書の締結",         category: DOC,   owner: "hr" },
  { title: "本人確認書類",                 category: DOC,   owner: "employee" },
  { title: "インボイス登録番号の届出",     category: DOC,   owner: "employee" },
  { title: "報酬振込口座の届出",           category: DOC,   owner: "employee" },
  { title: "メールアカウントの発行",       category: ACCOUNT, owner: "hr" },
  { title: "グループウェアの招待",         category: ACCOUNT, owner: "hr" },
];

const OFFBOARDING = [
  { title: "退職届の受理",                 category: DOC,   owner: "employee" },
  { title: "健康保険証の返却",             category: DOC,   owner: "employee", share_with_advisor: true },
  { title: "PC・備品の返却",               category: EQUIP, owner: "employee" },
  { title: "業務の引き継ぎ",               category: TASK,  owner: "employee" },
  { title: "各種アカウントの停止",         category: ACCOUNT, owner: "hr" },
  { title: "社会保険の資格喪失届",         category: TASK,  owner: "labor_advisor", share_with_advisor: true },
  { title: "雇用保険の資格喪失届・離職票", category: TASK,  owner: "labor_advisor", share_with_advisor: true },
  { title: "源泉徴収票の交付",             category: DOC,   owner: "hr", share_with_advisor: true },
  { title: "最終給与・精算",               category: TASK,  owner: "hr" },
];

/**
 * 既定のチェックリストを返す。
 * @param {'onboarding'|'offboarding'} kind
 * @param {string|null} employmentType gw_employees.employment_type
 */
export function defaultChecklist(kind, employmentType) {
  if (kind === "offboarding") return withOrder(OFFBOARDING);
  if (employmentType === "業務委託") return withOrder(ONBOARDING_CONTRACTOR);
  return withOrder(ONBOARDING_COMMON);
}

function withOrder(items) {
  return items.map((it, i) => ({
    title: it.title,
    category: it.category,
    owner: it.owner,
    required: it.required !== false,
    share_with_advisor: !!it.share_with_advisor,
    sort_order: (i + 1) * 10,
  }));
}
