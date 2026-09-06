// 新規メンバー登録のあとに、入社準備を一式そろえる。
//
// ■ なぜ登録と同時に作るのか
//   これまでは、登録フォームを出したあと、管理者が admin-hr.html を開いて
//   手続きをもう一度作っていた。作り忘れると、入社日に何も準備されていない。
//
//   登録フォームを1回出せば、
//     手続き（gw_procedures）
//     チェックリスト（書類・準備タスク・社労士項目）
//     本人用フォームの受け皿
//     Google Drive の個人フォルダ
//   まで、まとめてできる状態にする。
//
// ■ 失敗しても、登録そのものは成立させる
//   Drive が未設定の環境でも、手続きは作る。
//   手続きが作れなくても、名簿とアカウントはもう作られている。
//   途中で例外を投げて全部を無かったことにすると、
//   何がどこまでできたのか分からなくなる。

import { defaultChecklist } from "./onboarding.js";
import { PREP_TASKS, FORM_ITEMS } from "./onboard-form.js";
import { DOCS, asChecklistItems, docByTitle } from "./onboard-docs.js";
import { ensureProcedureFolders, shareEmployeeFolders } from "./hr-drive.js";

// 既定チェックリスト（lib/onboarding.js）のうち、いま残す項目。
//
// 昔の一覧には「PC・備品の貸与」「初日の受け入れ準備」「メールアカウントの発行」
// なども入っていたが、いまは
//   本人が出す書類 … lib/onboard-docs.js
//   本人フォーム   … lib/onboard-form.js の FORM_ITEMS
//   会社側の準備   … 同 PREP_TASKS
//   アカウント     … 登録と同時に作られる
// が受け持っている。同じことを2行に分けて書くと、
// どちらに丸を付けたのか分からなくなるので、重なるぶんは足さない。
const KEEP_FROM_DEFAULT = new Set([
  "雇用契約書の締結",
  "業務委託契約書の締結",
  "社会保険の資格取得届",
  "雇用保険の資格取得届",
]);

// 昔の題名 → いまの鍵。中身が同じものだけを結ぶ。
// 「メールアカウントの発行」と「Slack アカウント発行」のように
// 似ているが別のものは、結ばない
const LEGACY_KEYS = new Map([
  ["給与振込口座の届出", "form_bank"],
  ["緊急連絡先の届出", "form_emergency"],
  ["PC・備品の貸与", "prep_pc"],
  ["初日の受け入れ準備", "prep_intro"],
]);

const KEYED_BY_TITLE = new Map(
  [...FORM_ITEMS, ...PREP_TASKS].map((i) => [i.title, i.item_key]));

/**
 * 入社手続き一式を作る。
 *
 * @param {object} emp    gw_employees の行
 * @param {object} master 正規化済みのマスター1件（lib/intake.js）
 * @returns {Promise<{procedureId:string|null, items:number, drive:string|null, error:string|null}>}
 */
export async function createOnboardingKit(sb, ctx, user, emp, master) {
  const out = { procedureId: null, items: 0, drive: null, error: null };

  try {
    // 1) 手続き。1人1つ（employee_id, kind で一意）なので、
    //    すでにあれば作り直さない
    const { data: existing } = await sb.from("gw_procedures")
      .select("id").eq("employee_id", emp.id).eq("kind", "onboarding").maybeSingle();

    let procedureId = existing?.id || null;
    if (!procedureId) {
      const { data, error } = await sb.from("gw_procedures").insert({
        tenant_id: ctx.tenantId,
        employee_id: emp.id,
        kind: "onboarding",
        status: "in_progress",
        target_on: master.join_date,
        note: "新規メンバー登録から自動で作成しました",
        created_by: user.id,
      }).select("id").single();
      if (error) throw new Error(error.message);
      procedureId = data.id;
    }
    out.procedureId = procedureId;

    // 2) チェックリスト。
    //    既定の書類・手続き（雇用区分で変わる）＋ 本人フォームが埋める項目
    //    ＋ PC・Slack・勤怠・ロッカーの準備タスク。
    //    ぜんぶ同じ表に入れる。管理画面で1つのリストとして見えるようにするため
    const employmentType = master.contract_type === "有期" ? "契約社員" : "正社員";
    // 本人が出す書類は lib/onboard-docs.js が正（鍵付き・Driveの置き場所付き）。
    // 既定のチェックリストからは、本人が出す書類と本人フォームで受け取るものを外し、
    // 会社側・社労士側のタスクだけを使う。同じ項目が2つ並ばないように
    const base = defaultChecklist("onboarding", employmentType)
      .filter((i) => i.owner !== "employee" && KEEP_FROM_DEFAULT.has(i.title))
      .map((i) => ({ ...i, item_key: null }));

    const rows = [
      ...FORM_ITEMS.map((i, n) => ({ ...i, required: true, share_with_advisor: false, sort_order: (n + 1) * 10 })),
      ...asChecklistItems().map((i, n) => ({ ...i, sort_order: 100 + (n + 1) * 10 })),
      ...base.map((i, n) => ({ ...i, sort_order: 300 + (n + 1) * 10 })),
      ...PREP_TASKS.map((i, n) => ({ ...i, required: true, share_with_advisor: false, sort_order: 500 + (n + 1) * 10 })),
    ];

    // すでにある項目は足さない。登録をやり直しても二重にならないように
    const { data: had } = await sb.from("gw_procedure_items")
      .select("item_key, title").eq("procedure_id", procedureId);
    const haveKey = new Set((had || []).map((i) => i.item_key).filter(Boolean));
    const haveTitle = new Set((had || []).map((i) => i.title));

    const toAdd = rows.filter((r) =>
      r.item_key ? !haveKey.has(r.item_key) : !haveTitle.has(r.title));

    if (toAdd.length) {
      const { error } = await sb.from("gw_procedure_items").insert(
        toAdd.map((r) => ({
          tenant_id: ctx.tenantId,
          procedure_id: procedureId,
          item_key: r.item_key || null,
          title: r.title,
          category: r.category,
          owner: r.owner,
          required: r.required !== false,
          share_with_advisor: !!r.share_with_advisor,
          // 入社日を期限にする。日付未定なら期限も置かない
          due_on: master.join_date || null,
          sort_order: r.sort_order,
        })));
      if (error) throw new Error(error.message);
      out.items = toAdd.length;
    }

    // 古い作りの手続きをやり直したとき用。鍵の無い項目を結び直し、
    // 同じ書類が2行になっているものを片付ける
    await ensureDocItems(sb, ctx.tenantId, procedureId);

    // 3) 本人フォームの受け皿。空の行を先に作っておく。
    //    本人が初めて開いたときに「まだ何も無い」ではなく
    //    「入力してください」の状態から始められるようにする
    await sb.from("gw_onboard_profiles").upsert({
      tenant_id: ctx.tenantId,
      employee_id: emp.id,
      user_id: emp.user_id || null,
      status: "draft",
      updated_at: new Date().toISOString(),
    }, { onConflict: "employee_id" });

    // 4) Google Drive の個人フォルダ一式。
    //    ルート ＋ 01〜05 ＋ 機微情報（個人フォルダの外）。
    //    未設定の環境では作らない（手続きは成立）
    try {
      const folder = await ensureProcedureFolders({
        kind: "onboarding", targetOn: master.join_date, displayName: master.name,
      });
      if (folder.folderId) {
        // 本人にも、自分のフォルダを渡しておく。
        // 入社手続きの画面から、書類ごとに直接あげられるようにするため。
        // 渡すのは 01・03・04・05 と機微情報だけ（02_労働条件・契約 は渡さない）。
        // 会社のドメイン以外には自動で渡さない（lib/hr-drive.js）
        const email = master.login_email || emp.email || null;
        const share = await shareEmployeeFolders(
          { folders: folder.folders, sensitiveFolderId: folder.sensitiveFolderId }, email);
        out.driveShared = share.shared?.length ? email : null;

        await sb.from("gw_procedures").update({
          drive_folder_id: folder.folderId,
          drive_link: folder.link,
          drive_folders: share.shared?.length
            ? { ...folder.folders, _sharedWith: [email] }
            : folder.folders,
          drive_sensitive_folder_id: folder.sensitiveFolderId,
          updated_at: new Date().toISOString(),
        }).eq("id", procedureId);
        out.drive = folder.link;
      }
    } catch (e) {
      // フォルダが作れなくても手続きは成立する。画面のボタンから作り直せる
      console.error("[onboard-kit] 個人フォルダを作れませんでした:", e.message);
    }
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 300);
    console.error("[onboard-kit] 入社準備を作れませんでした:", out.error);
  }

  return out;
}

/**
 * 古いチェックリストを、いまの定義につなぎ直す。
 *
 * ■ なぜ要るのか
 *   item_key（項目の鍵）は途中から入れた。それより前に作られた手続きの項目は
 *   鍵が空のまま残っている。鍵が無いと、
 *     ・画面の「ご提出いただく書類」と結び付かない
 *       → アップロードのボタンを押しても何も起きない（送り先の項目が分からない）
 *     ・Drive のどのフォルダに入れるかも決まらない
 *   さらに、あとから足した新しい項目と昔の項目が並んで、同じ書類が2つ出る。
 *
 * ■ やること（この3つだけ）
 *   1. 鍵の空いている項目を、題名から定義に結び直す
 *   2. 同じ書類が2行あるときは、まだ何も入っていない方を消す
 *   3. 定義にあるのに1行も無い書類を足す
 *
 * ■ 消してよい行の条件
 *   鍵が空で／同じ鍵の行が既にあって／status が todo で／ファイルが1つも付いていない。
 *   人が丸を付けた行も、本人が出したファイルが付いている行も、消さない。
 *
 * @returns {Promise<{linked:number, removed:number, added:number}>}
 */
export async function ensureDocItems(sb, tenantId, procedureId) {
  const out = { linked: 0, removed: 0, added: 0 };
  if (!procedureId) return out;

  const { data: items } = await sb.from("gw_procedure_items")
    .select("id, item_key, title, status, sort_order")
    .eq("procedure_id", procedureId).limit(300);
  if (!items) return out;

  const taken = new Set(items.map((i) => i.item_key).filter(Boolean));
  const now = new Date().toISOString();

  // 何かが付いている行は消さない。先に調べておく
  const orphan = items.filter((i) => !i.item_key);
  let withFile = new Set();
  if (orphan.length) {
    const { data: files } = await sb.from("gw_procedure_files")
      .select("item_id").eq("procedure_id", procedureId).limit(500);
    withFile = new Set((files || []).map((f) => f.item_id).filter(Boolean));
  }

  for (const it of orphan) {
    const doc = docByTitle(it.title);
    const key = doc ? doc.key : (KEYED_BY_TITLE.get(it.title) || LEGACY_KEYS.get(it.title) || null);
    if (!key) continue;                       // 人が手で足した項目。そのまま残す

    if (!taken.has(key)) {
      // 1) 結び直す。題名も定義に合わせる（「年金手帳・基礎年金番号」→ 通知書）
      const patch = { item_key: key, updated_at: now };
      if (doc) {
        patch.title = doc.title;
        patch.category = "document";
        patch.owner = "employee";
        patch.share_with_advisor = !!doc.advisor;
      }
      const { error } = await sb.from("gw_procedure_items").update(patch).eq("id", it.id);
      if (!error) { taken.add(key); out.linked++; }
    } else if (it.status === "todo" && !withFile.has(it.id)) {
      // 2) 同じ書類が2行ある。空の方を消す
      const { error } = await sb.from("gw_procedure_items").delete().eq("id", it.id);
      if (!error) out.removed++;
    }
  }

  // 3) 定義にあるのに無い書類を足す
  const missing = asChecklistItems().filter((r) => !taken.has(r.item_key));
  if (missing.length) {
    const { error } = await sb.from("gw_procedure_items").insert(
      missing.map((r, n) => ({
        tenant_id: tenantId,
        procedure_id: procedureId,
        item_key: r.item_key,
        title: r.title,
        category: r.category,
        owner: r.owner,
        required: r.required !== false,
        share_with_advisor: !!r.share_with_advisor,
        sort_order: 100 + (DOCS.findIndex((d) => d.key === r.item_key) + 1) * 10,
      })));
    if (!error) out.added = missing.length;
  }

  return out;
}

/**
 * 本人フォームの状態を、チェックリストへ反映する。
 *
 * 本人フォームとチェックリストを別々に管理すると、
 * 「フォームは出したのにチェックが付いていない」が起きる。
 * フォームの提出をそのまま項目の状態にする。
 *
 * 完了（done）にはしない。確認するのは人事の仕事で、
 * ここで done にすると、誰も中身を見ないまま揃ったことになる。
 */
export async function syncFormItems(sb, procedureId, { profileSubmitted, consentDone }) {
  const state = {
    form_profile: profileSubmitted,
    form_bank: profileSubmitted,
    form_emergency: profileSubmitted,
    form_consent: consentDone,
  };

  const { data: items } = await sb.from("gw_procedure_items")
    .select("id, item_key, status").eq("procedure_id", procedureId)
    .in("item_key", Object.keys(state));

  for (const i of items || []) {
    const want = state[i.item_key] ? "submitted" : "todo";
    // 人事が確認済み（done）にしたものは戻さない
    if (i.status === "done" || i.status === "na" || i.status === want) continue;
    await sb.from("gw_procedure_items")
      .update({ status: want, updated_at: new Date().toISOString() })
      .eq("id", i.id);
  }
}
