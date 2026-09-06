// 入社時に本人から出してもらう書類と、Google Drive の置き場所。
//
// ■ 本人に Drive を触らせない
//   本人がやるのは、mf の画面で 雛形をダウンロード → 記入 → アップロード だけ。
//   Drive のどこに入るか、名前をどう付けるかは、こちらで決める。
//   人が置くと、フォルダも名前もばらつく。
//
// ■ フォルダ構成（1人1つ）
//   01_採用・履歴書
//   02_労働条件・契約
//   03_入社提出書類
//   04_社会保険・労務   ← 社労士に共有するのはここだけ
//   05_その他
//
// ■ 機微情報は別の場所
//   マイナンバー確認書類は、個人フォルダの中に置かない。
//   人事ルートの下の別の木（機微情報/年/氏名）に置く。
//   個人フォルダを誰かに共有しても、そこは付いてこない。
//   番号法の安全管理措置は「見られる人を最小にする」ことなので、
//   置き場所そのものを分けるのがいちばん確実。
//
// ■ ファイル名
//   YYYYMMDD_書類名_氏名.拡張子
//   日付を先頭にするのは、フォルダの中で時系列に並ぶようにするため。

export const FOLDERS = [
  { key: "01", name: "01_採用・履歴書" },
  { key: "02", name: "02_労働条件・契約" },
  { key: "03", name: "03_入社提出書類" },
  { key: "04", name: "04_社会保険・労務" },
  { key: "05", name: "05_その他" },
];

/** 機微情報の置き場所。個人フォルダの外 */
export const SENSITIVE_FOLDER = "機微情報";

/** 社労士に共有するフォルダ */
export const ADVISOR_FOLDER_KEY = "04";

/**
 * 本人から出してもらう書類。
 *
 *   key       … gw_procedure_items.item_key。画面と突き合わせる鍵
 *   folder    … 置くフォルダ（FOLDERS の key）。sensitive のときは無視される
 *   sensitive … マイナンバー等。機微情報フォルダへ
 *   template  … 雛形。url は外部（国税庁など）のPDF。null は雛形なし（本人が持っているもの）
 *   advisor   … 社労士に見せてよいか（gw_procedure_items.share_with_advisor）
 *   required  … 必須か
 */
export const DOCS = [
  {
    key: "doc_resume",
    title: "履歴書・職務経歴書",
    aliases: ["履歴書", "職務経歴書"],
    desc: "採用時にお出しいただいたものと同じで構いません。",
    folder: "01",
    template: null,
    required: true,
    advisor: false,
  },
  {
    key: "doc_mynumber",
    title: "マイナンバー確認書類",
    desc: "マイナンバーカードの両面、または通知カード＋本人確認書類の写真。",
    folder: "03",
    sensitive: true,
    template: null,
    required: true,
    advisor: true,
  },
  {
    key: "doc_dependents",
    title: "扶養控除等申告書",
    desc: "扶養する家族がいない方も提出が必要です。氏名・住所と、扶養の有無を記入します。",
    folder: "04",
    template: {
      label: "国税庁の様式（PDF）",
      url: "https://www.nta.go.jp/taxes/tetsuzuki/shinsei/annai/gensen/annai/1648_01.htm",
    },
    required: true,
    advisor: true,
  },
  {
    key: "doc_pension",
    title: "年金手帳・基礎年金番号通知書",
    aliases: ["年金手帳・基礎年金番号", "年金手帳"],
    desc: "基礎年金番号が分かるページの写真。初めて働く方は「ありません」で構いません。",
    folder: "04",
    template: null,
    required: false,
    advisor: true,
  },
  {
    key: "doc_employment_ins",
    title: "雇用保険被保険者証",
    desc: "前の勤務先から受け取ったもの。初めて働く方は「ありません」で構いません。",
    folder: "04",
    template: null,
    required: false,
    advisor: true,
  },
  {
    key: "doc_withholding",
    title: "前職の源泉徴収票",
    aliases: ["源泉徴収票"],
    desc: "同じ年に前の勤務先で給与があった方のみ。年末調整に使います。",
    folder: "04",
    template: null,
    required: false,
    advisor: true,
  },
];

export const docOf = (key) => DOCS.find((d) => d.key === key) || null;

/**
 * 題名から書類を引く。
 *
 * item_key を付ける前に作られたチェックリストの項目を、
 * 定義に結び付け直すのに使う。題名は画面から変えられるので、
 * ここで拾えなかったものは「人が足した項目」として別に扱う
 */
export const docByTitle = (title) => {
  const t = String(title || "").trim();
  if (!t) return null;
  return DOCS.find((d) => d.title === t || (d.aliases || []).includes(t)) || null;
};

/** 置くフォルダの key。機微情報は null（別の木へ） */
export const folderKeyOf = (doc) => (doc?.sensitive ? null : doc?.folder || "05");

/**
 * Drive に置くときのファイル名。YYYYMMDD_書類名_氏名.拡張子
 * @param {string} date   YYYY-MM-DD
 * @param {string} title  書類名
 * @param {string} name   氏名
 * @param {string} filename 元のファイル名（拡張子を取るため）
 */
export function driveFileName(date, title, name, filename) {
  const ymd = String(date || "").replace(/-/g, "").slice(0, 8) || "00000000";
  const ext = /\.([a-z0-9]{1,8})$/i.exec(String(filename || ""))?.[1]?.toLowerCase() || "bin";
  const clean = (s) => String(s || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "").trim();
  return `${ymd}_${clean(title)}_${clean(name)}.${ext}`;
}

/** チェックリスト（gw_procedure_items）に入れる形 */
export const asChecklistItems = () =>
  DOCS.map((d) => ({
    item_key: d.key,
    title: d.title,
    category: "document",
    owner: "employee",
    required: d.required !== false,
    share_with_advisor: !!d.advisor,
  }));
