// 個人情報の保存期限と削除。
//
// ■ 種別ごとに「何を起点に・何か月」
//
//   履歴書        … 退職後 3年     （労働者名簿と同じ期間）
//   本人確認資料  … 手続き完了後 1年（年金手帳・雇用保険証・源泉徴収票の写し。届出が済めば要らない）
//   口座情報      … 退職後 1年     （最終給与の振込が終われば要らない）
//   契約関連書類  … 退職後 5年     （労基法109条。当分のあいだ3年でもよいが、長い方に合わせる）
//   入社情報の届出 … 退職後 3年
//
//   既定はここ。会社ごとの上書きは gw_retention_rules。
//   期限は「起点の日 ＋ 月数」。起点が来ていない人（在籍中）は期限が無い。
//
// ■ 消すのは3つの入れ物
//
//   1. 提出書類（gw_procedure_files ＋ hr バケットの実体）
//   2. 届出の口座欄（gw_onboard_profiles の bank_*）／届出そのもの
//   3. 契約書（gw_sign_requests の PDF ＋ 作成依頼の PDF）
//
//   消したことは gw_retention_log に残す。消したものより長く残る。
//   ログが無い削除は、消したことにならない（「消しました」を証明できない）。
//
// ■ 自動で消すのは、auto_delete を付けた種別だけ
//
//   既定は付けない。cron は「期限切れがあります」と管理者に知らせるところまで。
//   自動で消すと決めたら、その種別だけ auto_delete を付ける。
//   取り消しがきかないので、既定を「消す」側にはしない。

export const RETENTION_KINDS = [
  { key: "resume",   label: "履歴書・職務経歴書", base: "leave",    months: 36,
    itemKeys: ["doc_resume"], what: "files" },
  { key: "identity", label: "本人確認資料",       base: "complete", months: 12,
    itemKeys: ["doc_pension", "doc_employment_ins", "doc_withholding", "doc_dependents"], what: "files" },
  { key: "bank",     label: "口座情報",           base: "leave",    months: 12,
    itemKeys: [], what: "bank" },
  { key: "contract", label: "契約関連書類",       base: "leave",    months: 60,
    itemKeys: ["doc_contract", "doc_contract_gyomu"], what: "contracts" },
  { key: "profile",  label: "入社情報の届出",     base: "leave",    months: 36,
    itemKeys: [], what: "profile" },
];
export const RETENTION_KEYS = RETENTION_KINDS.map((k) => k.key);
export const kindOf = (key) => RETENTION_KINDS.find((k) => k.key === key) || null;

export const BASE_LABEL = { leave: "退職日", complete: "入社手続き完了日" };

/** 既定にDBの上書きを重ねる */
export function rulesWith(overrides) {
  const by = new Map((overrides || []).map((r) => [r.kind, r]));
  return RETENTION_KINDS.map((k) => {
    const o = by.get(k.key);
    return {
      key: k.key, label: k.label, base: k.base, baseLabel: BASE_LABEL[k.base],
      months: o?.months ?? k.months,
      autoDelete: o?.auto_delete === true,
      defaultMonths: k.months,
      updatedAt: o?.updated_at || null,
    };
  });
}

/** YYYY-MM-DD に n か月を足す（日付だけ。時刻の計算は挟まない） */
export function addMonths(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ""));
  if (!m) return null;
  let y = Number(m[1]);
  let mo = Number(m[2]) - 1 + n;
  const d = Number(m[3]);
  y += Math.floor(mo / 12);
  mo = ((mo % 12) + 12) % 12;
  // 月末を越えるとき（1/31 + 1か月）はその月の末日
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return `${y}-${String(mo + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/**
 * その人・その種別の期限。起点が来ていなければ null
 * @param {object} rule   rulesWith() の1つ
 * @param {object} dates  { leftOn, completedOn }  どちらも YYYY-MM-DD か null
 */
export function dueOf(rule, dates) {
  const base = rule.base === "leave" ? dates?.leftOn : dates?.completedOn;
  if (!base) return null;
  return addMonths(base, rule.months);
}

/**
 * 期限切れの一覧を出す（純粋）。
 *
 * @param {object[]} rules    rulesWith()
 * @param {object[]} people   [{ id, name, leftOn, completedOn, counts: {resume, identity, bank, contract, profile} }]
 * @param {string}   today    YYYY-MM-DD
 * @returns {object[]} [{ employeeId, name, kind, label, dueOn, expired, daysLeft, count, autoDelete }]
 */
export function scheduleOf(rules, people, today) {
  const out = [];
  for (const p of people || []) {
    for (const r of rules) {
      const count = p.counts?.[r.key] || 0;
      if (!count) continue;                                  // 消すものが無い
      const dueOn = dueOf(r, p);
      if (!dueOn) continue;                                  // 起点が来ていない
      const daysLeft = Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
      out.push({
        employeeId: p.id, name: p.name, kind: r.key, label: r.label,
        dueOn, daysLeft, expired: daysLeft <= 0, count, autoDelete: r.autoDelete,
      });
    }
  }
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

/**
 * その人の、種別ごとの「消すものの数」を数える（純粋）。
 * @param {object} d { files: [{item_key}], profile: {bank_number, status}, contracts: [{status}] }
 */
export function countTargets(d) {
  const files = d.files || [];
  const inKeys = (keys) => files.filter((f) => keys.includes(f.item_key)).length;
  const pf = d.profile || null;
  const hasBank = !!(pf && (pf.bank_number || pf.bank_name || pf.bank_holder));
  const hasProfile = !!(pf && (pf.address || pf.phone || pf.birth_date || pf.emg_phone));
  return {
    resume:   inKeys(kindOf("resume").itemKeys),
    identity: inKeys(kindOf("identity").itemKeys),
    bank:     hasBank ? 1 : 0,
    contract: inKeys(kindOf("contract").itemKeys) + (d.contracts || []).length,
    profile:  hasProfile ? 1 : 0,
  };
}

/**
 * 会社の人ぜんぶについて、起点の日と「消すものの数」を集める。
 * 一覧（api/hr/retention.js）と cron（api/cron/retention.js）の両方がこれを使う
 *
 * @returns {Promise<object[]>} scheduleOf() に渡す people
 */
export async function collectPeople(sb, tenantId) {
  const soft = async (p) => { try { return (await p)?.data ?? []; } catch { return []; } };
  const [emps, procs, profiles, signs, files] = await Promise.all([
    soft(sb.from("gw_employees").select("id, display_name, status, left_on, joined_on")
      .eq("tenant_id", tenantId).limit(2000)),
    soft(sb.from("gw_procedures").select("id, employee_id, kind, status, stage, stage_at, updated_at")
      .eq("tenant_id", tenantId).eq("kind", "onboarding").limit(2000)),
    soft(sb.from("gw_onboard_profiles")
      .select("employee_id, bank_number, bank_name, bank_holder, address, phone, birth_date, emg_phone")
      .eq("tenant_id", tenantId).limit(2000)),
    soft(sb.from("gw_sign_requests").select("employee_id, pdf_path, signed_pdf_path")
      .eq("tenant_id", tenantId).limit(5000)),
    soft(sb.from("gw_procedure_files").select("id, procedure_id, item_id")
      .eq("tenant_id", tenantId).limit(5000)),
  ]);

  const procIds = procs.map((p) => p.id);
  const items = procIds.length
    ? await soft(sb.from("gw_procedure_items").select("id, procedure_id, item_key")
        .in("procedure_id", procIds).limit(10000))
    : [];
  const keyOfItem = new Map(items.map((i) => [i.id, i.item_key]));
  const empOfProc = new Map(procs.map((p) => [p.id, p.employee_id]));

  const filesBy = new Map();
  for (const f of files) {
    const eid = empOfProc.get(f.procedure_id);
    if (!eid) continue;
    if (!filesBy.has(eid)) filesBy.set(eid, []);
    filesBy.get(eid).push({ item_key: keyOfItem.get(f.item_id) || null });
  }
  const profBy = new Map(profiles.map((p) => [p.employee_id, p]));
  const signsBy = new Map();
  for (const s of signs) {
    if (!s.pdf_path && !s.signed_pdf_path) continue;
    if (!signsBy.has(s.employee_id)) signsBy.set(s.employee_id, []);
    signsBy.get(s.employee_id).push(s);
  }
  const doneBy = new Map();
  for (const p of procs) {
    if (p.status !== "done" && p.stage !== "complete") continue;
    const on = String(p.stage_at || p.updated_at || "").slice(0, 10) || null;
    if (on) doneBy.set(p.employee_id, on);
  }

  return emps.map((e) => ({
    id: e.id, name: e.display_name,
    leftOn: e.status === "left" ? (e.left_on || null) : null,
    completedOn: doneBy.get(e.id) || null,
    counts: countTargets({
      files: filesBy.get(e.id) || [], profile: profBy.get(e.id) || null, contracts: signsBy.get(e.id) || [],
    }),
  }));
}

/** 口座欄だけ空にする patch */
export const BANK_FIELDS = ["bank_name", "bank_branch", "bank_type", "bank_number", "bank_holder"];
/** 届出そのものを空にする patch（口座を含む。状態と提出日は残す＝「出したこと」は消さない） */
export const PROFILE_FIELDS = [
  ...BANK_FIELDS,
  "name_kana", "birth_date", "postal_code", "address", "phone",
  "emg_name", "emg_relation", "emg_phone",
  "commute_from", "commute_route", "commute_cost",
  "pension_number", "employment_ins_number", "has_dependents", "dependents_note", "dependents",
  "greeting",
];

/**
 * 実際に消す。呼ぶ側が権限を確かめてから。
 *
 * @param {object} sb      service_role
 * @param {object} p       { tenantId, employeeId, kind, actor:{id,name}|null, reason:'expired'|'manual', dueOn, today }
 * @returns {Promise<{deleted:number, log:number, errors:string[]}>}
 */
export async function deleteFor(sb, p) {
  const rule = kindOf(p.kind);
  const out = { deleted: 0, log: 0, errors: [] };
  if (!rule) { out.errors.push("知らない種別です"); return out; }

  const { data: emp } = await sb.from("gw_employees").select("id, display_name")
    .eq("id", p.employeeId).eq("tenant_id", p.tenantId).maybeSingle();
  const name = emp?.display_name || null;
  const logs = [];
  const logRow = (target, label, detail) => ({
    tenant_id: p.tenantId, subject_id: p.employeeId, subject_name: name,
    kind: p.kind, target, label: label || null,
    deleted_by: p.actor?.id || null, actor_name: p.actor?.name || null,
    reason: p.reason || "manual", due_on: p.dueOn || null, detail: detail || null,
  });

  // ---- 1. 提出書類 ----
  if (rule.what === "files" || rule.what === "contracts") {
    const { data: procs } = await sb.from("gw_procedures").select("id")
      .eq("tenant_id", p.tenantId).eq("employee_id", p.employeeId);
    const procIds = (procs || []).map((x) => x.id);
    if (procIds.length && rule.itemKeys.length) {
      const { data: items } = await sb.from("gw_procedure_items").select("id, item_key, title")
        .in("procedure_id", procIds).in("item_key", rule.itemKeys);
      const itemIds = (items || []).map((i) => i.id);
      const titleOf = new Map((items || []).map((i) => [i.id, i.title]));
      if (itemIds.length) {
        const { data: files } = await sb.from("gw_procedure_files")
          .select("id, item_id, filename, storage_path").in("item_id", itemIds);
        for (const f of files || []) {
          const rm = await sb.storage.from("hr").remove([f.storage_path]);
          if (rm?.error) { out.errors.push(`${f.filename}: ${rm.error.message}`); continue; }
          const { error } = await sb.from("gw_procedure_files").delete().eq("id", f.id);
          if (error) { out.errors.push(`${f.filename}: ${error.message}`); continue; }
          out.deleted++;
          logs.push(logRow(`file:${f.id}`, f.filename, { item: titleOf.get(f.item_id) || null }));
        }
      }
    }
  }

  // ---- 2. 契約書（署名依頼の PDF と、作成依頼の PDF） ----
  if (rule.what === "contracts") {
    const { data: reqs } = await sb.from("gw_sign_requests")
      .select("id, title, pdf_path, signed_pdf_path, status")
      .eq("tenant_id", p.tenantId).eq("employee_id", p.employeeId);
    for (const r of reqs || []) {
      const paths = [r.pdf_path, r.signed_pdf_path].filter(Boolean);
      if (paths.length) {
        const rm = await sb.storage.from("hr").remove(paths);
        if (rm?.error) { out.errors.push(`${r.title}: ${rm.error.message}`); continue; }
      }
      // 行は残す（締結した事実・日時・ハッシュは記録として要る）。本文と PDF だけ消す
      const { error } = await sb.from("gw_sign_requests").update({
        pdf_path: null, signed_pdf_path: null, body_snapshot: "（保存期限を過ぎたため削除しました）",
        merged_fields: {}, updated_at: new Date().toISOString(),
      }).eq("id", r.id);
      if (error) { out.errors.push(`${r.title}: ${error.message}`); continue; }
      out.deleted++;
      logs.push(logRow(`sign:${r.id}`, r.title, { status: r.status, paths: paths.length }));
    }
    const { data: orders } = await sb.from("gw_doc_orders").select("id, title, file_path")
      .eq("tenant_id", p.tenantId).eq("employee_id", p.employeeId);
    for (const o of orders || []) {
      if (!o.file_path) continue;
      const rm = await sb.storage.from("hr").remove([o.file_path]);
      if (rm?.error) { out.errors.push(`${o.title}: ${rm.error.message}`); continue; }
      await sb.from("gw_doc_orders").update({ file_path: null, updated_at: new Date().toISOString() }).eq("id", o.id);
      out.deleted++;
      logs.push(logRow(`order:${o.id}`, o.title, null));
    }
  }

  // ---- 3. 届出（口座だけ／全部） ----
  if (rule.what === "bank" || rule.what === "profile") {
    const fields = rule.what === "bank" ? BANK_FIELDS : PROFILE_FIELDS;
    const patch = Object.fromEntries(fields.map((k) => [k, k === "dependents" ? [] : null]));
    patch.updated_at = new Date().toISOString();
    const { data: pf } = await sb.from("gw_onboard_profiles").select("id")
      .eq("employee_id", p.employeeId).maybeSingle();
    if (pf) {
      const { error } = await sb.from("gw_onboard_profiles").update(patch).eq("id", pf.id);
      if (error) out.errors.push(`届出: ${error.message}`);
      else {
        out.deleted++;
        logs.push(logRow(rule.what === "bank" ? "profile:bank" : "profile:all",
          rule.what === "bank" ? "給与振込口座" : "入社情報の届出", { fields: fields.length }));
      }
    }
  }

  if (logs.length) {
    const { error } = await sb.from("gw_retention_log").insert(logs);
    if (error) out.errors.push(`削除の記録: ${error.message}`);
    else out.log = logs.length;
  }
  return out;
}
