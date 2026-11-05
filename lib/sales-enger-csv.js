// エイト社内の経営者専用 CSV エクスポート（Excelでも値を文字列として扱う）。
// CSV式インジェクション防止。旧資料の優先度・過去面談は取引の確定実績と混同しない。
export const ENGER_CSV_COLUMNS = [
  ["id","ENGER企業ID"],
  ["name","企業名"],
  ["bucketLabel","営業区分"],
  ["status","ENGER登録ステータス"],
  ["industry","業種"],
  ["prefecture","都道府県"],
  ["address","住所"],
  ["website","ホームページ"],
  ["phone","電話番号（要有効性確認）"],
  ["email","メールアドレス（要許可確認）"],
  ["contactName","担当者名（要確認）"],
  ["priority","営業優先度"],
  ["oldPriority","旧営業資料優先度"],
  ["oldActivities","旧営業活動記録数（参考）"],
  ["oldLastDate","旧資料の最終接触日"],
  ["lastContacted","ENGER記録上の最終連絡"],
  ["meetingDone","打ち合わせ済み記録"],
  ["meetingAt","打ち合わせ日"],
  ["relationshipStatus","確認済み取引区分"],
  ["relationshipEvidence","取引確認の根拠"],
  ["classificationBasis","企業区分の根拠"],
  ["siSesCandidate","SI/SES候補（業種ベース）"],
  ["needsContactReview","連絡・配信前の要確認"],
  ["excluded","営業一覧から除外"],
  ["dataSource","データ取得元"],
  ["registeredAt","企業DB登録日時"],
];
const CSV_FORMULA=/^[=+\-@\t\r\n]/;
export function csvCell(value) {
  let text=String(value??"").replace(/\0/g,"").replace(/\r\n?/g,"\n");
  // Excelの式実行や先頭空白/制御文字による式トリックを防ぐ。
  if (CSV_FORMULA.test(text.trimStart()) || /^[\t\r\n]/.test(text)) text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
export function renderEngerCompanyCsv(rows) {
  const header=ENGER_CSV_COLUMNS.map(([,label])=>csvCell(label)).join(",");
  return "\ufeff"+[header,...rows.map(r=>ENGER_CSV_COLUMNS.map(([key])=>csvCell(r[key])).join(","))].join("\r\n")+"\r\n";
}
export function enterpriseBucketLabel(bucket) {
  return ({existing:"既存（管理区分）",revive:"掘り起こし",new:"新規・未確認"})[bucket]||"未確認";
}
