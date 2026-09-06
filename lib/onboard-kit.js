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
import { ensureProcedureFolder } from "./hr-drive.js";

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
    const base = defaultChecklist("onboarding", employmentType)
      // 本人フォームで受け取るものは、あとで足す側に寄せる。
      // 同じ内容の項目が2つ並ぶと、どちらを埋めればよいか分からなくなる
      .filter((i) => !["給与振込口座の届出", "緊急連絡先の届出"].includes(i.title))
      .map((i) => ({ ...i, item_key: null }));

    const rows = [
      ...FORM_ITEMS.map((i, n) => ({ ...i, required: true, share_with_advisor: false, sort_order: (n + 1) * 10 })),
      ...base.map((i, n) => ({ ...i, sort_order: 200 + (n + 1) * 10 })),
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

    // 4) Google Drive の個人フォルダ。未設定の環境では作らない（手続きは成立）
    try {
      const folder = await ensureProcedureFolder({
        kind: "onboarding", targetOn: master.join_date, displayName: master.name,
      });
      if (folder.folderId) {
        await sb.from("gw_procedures").update({
          drive_folder_id: folder.folderId, drive_link: folder.link,
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
