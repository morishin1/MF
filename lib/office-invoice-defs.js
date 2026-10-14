// Office「請求・支払」の定義（1か所にまとめる）。API・CSV・画面の選択肢は、すべてここから出す。
//
// ■ インボイス区分は MFクラウド会計の名称に合わせる
//   適格 / 80%控除 / 70%控除 / 50%控除 / 30%控除 / 控除なし
//   （経過措置：2023/10〜2026/9 は 80%、2026/10〜2028/9 は 70%、2028/10〜2030/9 は 50%、2030/10〜2031/9 は 30%）
//   名称を変えるのは、この INVOICE_CLASSES だけ。画面の選択肢・API の検査・CSV の値が一緒に変わる。
//
// ■ 勘定科目・補助科目・部門・税区分は「自由入力＋候補リスト」
//   MFクラウドの正式名称と1文字でも違うと、CSV を取り込んだときにエラーか新規作成になる。
//   ここの DEFAULT_CANDIDATES は候補であって正解ではない。会社の設定（gw_office_payables_settings.candidates）で足せる。
//   MF の API 同期はしない。

/** MFクラウドの「インボイス」列の値 */
export const INVOICE_CLASSES = ["適格", "80%控除", "70%控除", "50%控除", "30%控除", "控除なし"];
export const isInvoiceClass = (v) => INVOICE_CLASSES.includes(v);

export const PAYMENT_METHODS = {
  transfer: "銀行振込",
  debit: "口座振替",
  card: "カード",
  cash: "現金",
  other: "その他",
};
export const isPaymentMethod = (v) => Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, v);

/** 休日の調整。prev＝前営業日、next＝翌営業日、none＝調整しない */
export const HOLIDAY_ADJUST = { prev: "前営業日", next: "翌営業日", none: "調整しない" };
export const isHolidayAdjust = (v) => Object.prototype.hasOwnProperty.call(HOLIDAY_ADJUST, v);

/** 支払期日の出どころ（決定順：請求書の明記 → 経理の入力 → 支払先マスタから計算 → 未設定） */
export const DUE_SOURCE_LABEL = {
  invoice: "請求書に記載",
  manual: "経理が入力",
  master: "支払先マスタから自動計算",
};

export const JOURNAL_STATUS_LABEL = { none: "未仕訳", draft: "下書き", confirmed: "仕訳済み" };

/** MFクラウドの「MF仕訳タイプ」列 */
export const MF_TYPE = { purchase: "債務", payment: "経費・債務支払" };

/** 既定の候補（会社の設定で足せる）。MF の正式名称と違う場合は、設定で直す */
export const DEFAULT_CANDIDATES = {
  accounts: [
    "外注費", "通信費", "消耗品費", "地代家賃", "広告宣伝費", "支払手数料", "仕入高", "会議費", "接待交際費",
    "旅費交通費", "水道光熱費", "新聞図書費", "研修費", "保険料", "租税公課", "諸会費", "雑費", "車両費", "リース料",
    "未払金", "買掛金", "未払費用", "普通預金", "当座預金", "現金", "預り金",
  ],
  sub_accounts: [],
  departments: [],
  tax_classes: ["課対仕入10%", "課対仕入8%軽", "対象外", "不課税", "非課税仕入"],
};

export const DEFAULT_SETTINGS = {
  holiday_adjust: "prev",
  default_credit_account: "未払金",
  default_source_account: "普通預金",
  default_payment_method: "transfer",
  fee_account: "支払手数料",
  fee_tax_class: "課対仕入10%",
};

/** タグの区切り（MF 仕訳帳インポートの複数タグ）。実インポートで確認する */
export const TAG_SEPARATOR = "|";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const FILE_MIME_EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

export const MAX_JOURNAL_LINES = 30;
export const MAX_YEN = 999999999999;
