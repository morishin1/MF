// 本人が出す入社フォームの中身と、入社準備の進み具合。
//
// ■ 同じことを二度書かせない
//   管理者が新規メンバー登録で入れたもの（氏名・メール・入社日・契約・
//   勤務時間・担当業務・給与）は、このフォームでは入力させない。
//   読み取り専用で見せて、違っていたら管理者に言ってもらう。
//
//   本人がここで入れたものは、社労士連絡用のテキストにもSlackの紹介文にも
//   そのまま流用する。転記させない。
//
// ■ マイナンバーは受け取らない
//   番号法が求める安全管理措置（取扱区域・アクセス記録・確実な廃棄）は、
//   列を1つ足して済む話ではない。ここでは書類を出したかだけを見て、
//   番号そのものは持たない。db/037 の冒頭に理由を書いた。
//
// ■ 準備タスクを別の表にしない
//   PC・Slack・勤怠・ロッカーは、チェックリスト（gw_procedure_items）の
//   項目として作る。別の表に分けると、管理画面で2つのリストを見ることになり、
//   「あと何が残っているか」が1か所で分からなくなる。

/** 本人が入れる欄。画面もこの定義から組み立てる */
export const FIELDS = [
  { group: "本人のこと", key: "name_kana",  label: "氏名（カナ）", required: true,  placeholder: "エイト タロウ" },
  { group: "本人のこと", key: "birth_date", label: "生年月日",     required: true,  type: "date" },
  { group: "本人のこと", key: "postal_code", label: "郵便番号",    required: true,  placeholder: "100-0001" },
  { group: "本人のこと", key: "address",    label: "住所",         required: true,  placeholder: "東京都千代田区…", wide: true },
  { group: "本人のこと", key: "phone",      label: "電話番号",     required: true,  placeholder: "090-0000-0000" },

  { group: "緊急連絡先", key: "emg_name",     label: "お名前",   required: true },
  { group: "緊急連絡先", key: "emg_relation", label: "続柄",     required: true, placeholder: "母" },
  { group: "緊急連絡先", key: "emg_phone",    label: "電話番号", required: true, placeholder: "090-0000-0000" },

  { group: "通勤", key: "commute_from",  label: "最寄駅・出発地", required: false, placeholder: "JR新宿駅" },
  { group: "通勤", key: "commute_route", label: "経路",           required: false, placeholder: "新宿→東京（JR中央線）", wide: true },
  { group: "通勤", key: "commute_cost",  label: "1か月の定期代",  required: false, type: "number", unit: "円" },

  { group: "給与の振込先", key: "bank_name",   label: "銀行名",   required: true, placeholder: "みずほ銀行" },
  { group: "給与の振込先", key: "bank_branch", label: "支店名",   required: true, placeholder: "東京営業部" },
  { group: "給与の振込先", key: "bank_type",   label: "預金種別", required: true, type: "select", options: ["普通", "当座"] },
  { group: "給与の振込先", key: "bank_number", label: "口座番号", required: true, placeholder: "1234567" },
  { group: "給与の振込先", key: "bank_holder", label: "口座名義（カナ）", required: true, placeholder: "エイト タロウ" },

  // 社会保険・雇用保険の手続きに要るもの。初めて働く人は空でよい
  { group: "保険の手続き", key: "pension_number", label: "基礎年金番号",
    required: false, placeholder: "1234-567890",
    note: "年金手帳・基礎年金番号通知書に書いてあります。初めて働く方は空のままで構いません" },
  { group: "保険の手続き", key: "employment_ins_number", label: "雇用保険被保険者番号",
    required: false, placeholder: "1234-567890-1",
    note: "前の勤務先の離職票などに書いてあります。初めて働く方は空のままで構いません" },
  { group: "保険の手続き", key: "has_dependents", label: "扶養する家族がいますか",
    required: false, type: "bool" },
  { group: "保険の手続き", key: "dependents_note", label: "扶養家族（続柄・氏名・生年月日）",
    required: false, wide: true, showIf: "has_dependents",
    placeholder: "妻・エイト ハナコ・1995-04-01" },

  { group: "ひとこと", key: "greeting", label: "みんなへの自己紹介",
    required: false, wide: true, rows: 3,
    note: "入社日に、社内へお知らせする文章に使います（任意）",
    placeholder: "前職では〜をしていました。よろしくお願いします。" },
];

export const GROUPS = [...new Set(FIELDS.map((f) => f.group))];

/** 同意してもらうもの。版を上げたら取り直す */
export const CONSENTS = [
  {
    kind: "pledge", version: "v1", label: "誓約書",
    summary: "会社の情報・お客様の情報を、在職中も退職後も外に出しません。"
      + "業務で作ったものの権利は会社に帰属します。",
  },
  {
    kind: "privacy", version: "v1", label: "個人情報の取扱い",
    summary: "お預かりした個人情報は、雇用管理・給与・社会保険の手続きにだけ使います。"
      + "社会保険の手続きのため、必要な範囲で社会保険労務士に提供します。",
  },
  {
    kind: "rules", version: "v1", label: "社内ルール",
    summary: "就業規則・情報の取扱いルールを読み、これに従って働きます。"
      + "内容は社内文書（ライブラリ）でいつでも読めます。",
  },
];

/**
 * 自動で作る準備タスク。
 * 既定のチェックリスト（lib/onboarding.js）に足す形で入れる。
 *
 * item_key は、あとから機械で引くための鍵。
 * 題名は画面から変えられるが、鍵は変わらない
 */
export const PREP_TASKS = [
  { item_key: "prep_pc",      title: "PCの準備・初期設定",      category: "equipment", owner: "hr" },
  { item_key: "prep_slack",   title: "Slack アカウント発行",     category: "account",   owner: "hr" },
  { item_key: "prep_timecard", title: "勤怠（タイムカード）の登録", category: "account",  owner: "hr" },
  { item_key: "prep_locker",  title: "ロッカー・座席の割り当て", category: "equipment", owner: "hr" },
  { item_key: "prep_intro",   title: "初日の受け入れ・顔合わせ", category: "task",      owner: "hr" },
];

/** 本人フォームが受け持つチェックリスト項目。ここが埋まると自動で提出済みになる */
export const FORM_ITEMS = [
  { item_key: "form_profile",  title: "個人情報の届出（入社フォーム）", category: "document", owner: "employee" },
  { item_key: "form_bank",     title: "給与振込口座の届出",             category: "document", owner: "employee" },
  { item_key: "form_emergency", title: "緊急連絡先の届出",              category: "document", owner: "employee" },
  { item_key: "form_consent",  title: "誓約書・個人情報・社内ルールの確認", category: "document", owner: "employee" },
];

// ---- 値の受け取り -------------------------------------------------------------

const text = (v, max = 300) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** 画面から来た値を、保存できる形にそろえる。列名を直接指定させない */
export function normalizeProfile(body) {
  const out = {};
  for (const f of FIELDS) {
    const v = body?.[f.key];
    if (f.type === "bool") {
      out[f.key] = v === true || v === "true" ? true : v === false || v === "false" ? false : null;
    } else if (f.type === "number") {
      const n = v === "" || v == null ? null : Number(v);
      out[f.key] = Number.isFinite(n) ? n : null;
    } else if (f.type === "date") {
      out[f.key] = /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : null;
    } else if (f.type === "select") {
      out[f.key] = f.options.includes(v) ? v : null;
    } else {
      out[f.key] = text(v, f.key === "greeting" ? 600 : 300);
    }
  }
  return out;
}

/** 出せる状態か。必須が埋まっているかだけを見る */
export function missingFields(profile) {
  return FIELDS
    .filter((f) => f.required)
    // 表示条件が付いている欄は、条件を満たすときだけ必須にする
    .filter((f) => !f.showIf || profile?.[f.showIf])
    .filter((f) => profile?.[f.key] === null || profile?.[f.key] === undefined || profile?.[f.key] === "")
    .map((f) => ({ key: f.key, label: f.label, group: f.group }));
}

/**
 * 入社準備の進み具合。
 *
 * 分母はチェックリストの項目数。na（対象外）にしたものは、
 * 分母からも外す。関係のない項目のせいで100%にならないと、
 * 「あと少し」なのか「まだ何かある」のかが分からなくなる。
 *
 * @returns {{done:number, total:number, pct:number, byOwner:object, blocking:Array}}
 */
export function progressOf(items = []) {
  const live = items.filter((i) => i.status !== "na");
  const done = live.filter((i) => i.status === "done").length;
  const total = live.length;

  const byOwner = {};
  for (const o of ["employee", "hr", "labor_advisor"]) {
    const rows = live.filter((i) => i.owner === o);
    byOwner[o] = {
      done: rows.filter((i) => i.status === "done").length,
      submitted: rows.filter((i) => i.status === "submitted").length,
      total: rows.length,
    };
  }

  return {
    done,
    total,
    pct: total ? Math.round((done / total) * 100) : 0,
    byOwner,
    // まだ手が付いていない必須項目。管理画面で「次に何をするか」を出すのに使う
    blocking: live
      .filter((i) => i.required && i.status === "todo")
      .map((i) => ({ id: i.id, title: i.title, owner: i.owner })),
  };
}
