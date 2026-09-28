// 採用決定 → 契約 → 入社 → キャリア → 育成 を、1人ずつ1本の流れとして見せる。
//
// ■ 新しい表は作らない。状態は既存の事実から毎回計算する
//   採用決定   … gw_hr_applicants（decision=hired・status=accepted、employee_id がまだ空）
//   契約・入社 … 入社手続きの段階（lib/onboard-stage.js computeStage。作成依頼・署名・届出・書類・社内準備）
//   キャリア   … lib/career.js flowOf（gw_employee_careers・本人確認・評価）
//   育成       … gw_growth_plans（既存の3か月育成）
//   どこかに「いまの状態」を書いておく作りにすると、事実と状態が必ずずれる。
//
// ■ 順番を飛ばさない
//   契約条件の提示 → 本人確認・署名 → 入社手続き。「書類を送った」だけでは次へ進まない
//   （署名が済むまで ④ 情報入力・提出 に入らない。サーバ側は lib/onboard-gate.js が止める）。
//
// ■ NEXT ACTION は1つ、Primary CTA も1つ
//   cta … { key, label, href? }。key は画面側の動き（meeting・review・growth）か、href で既存画面へ。

/** 状態は10個。増やしすぎない */
export const JOURNEY_STATES = [
  { key: "hired",              label: "採用決定" },
  { key: "contract_setup",     label: "契約条件設定" },
  { key: "document_preparing", label: "書類作成" },
  { key: "signing",            label: "本人確認・署名" },
  { key: "onboarding_info",    label: "入社情報入力" },
  { key: "documents_pending",  label: "必要書類提出" },
  { key: "company_review",     label: "会社・社労士確認" },
  { key: "career_setup",       label: "キャリア設定" },
  { key: "growth_active",      label: "3か月育成" },
  { key: "active",             label: "通常評価" },
];
export const JOURNEY_KEYS = JOURNEY_STATES.map((s) => s.key);
const stepNo = (k) => JOURNEY_KEYS.indexOf(k) + 1;

/** 担当（次に誰が動くか）の見せ方 */
export const ACTOR_LABELS = { hr: "人事", advisor: "社労士", employee: "本人", manager: "上長", owner: "経営者・人事" };

const slash = (d) => (d ? String(d).slice(0, 10).replace(/-/g, "/") : "");

/**
 * 入社手続き（④ 情報入力・提出）の中身を、本人の入力・本人の書類・会社側の確認に分ける。
 * 判定の考え方は lib/onboard-stage.js computeStage と同じ（マイナンバー書類は数えない）
 */
export function intakeBreakdown(facts = {}) {
  const items = facts.items || [];
  const isDone = (i) => i.status === "done" || i.status === "na";
  const isIn = (i) => isDone(i) || i.status === "submitted";
  const employeeOpen = items.filter((i) => i.owner === "employee" && i.required !== false
    && i.item_key !== "doc_mynumber" && !isIn(i));
  const internalOpen = items.filter((i) => i.owner !== "employee" && !isDone(i));
  return {
    profileSubmitted: facts.profile?.status === "submitted",
    employeeOpen: employeeOpen.length,
    internalOpen: internalOpen.length,
    orientationOk: facts.orientationOk !== false,
  };
}

/**
 * @param {object} p
 *   applicant   gw_hr_applicants の行（採用決定で、まだ社員になっていない人だけ）| null
 *   employee    { id } | null
 *   procedure   入社手続き { id, status } | null
 *   stage       computeStage の結果 { key } | null（手続きが無ければ null）
 *   facts       gatherFacts の結果（④ の中を分けるため）| null
 *   careerFlow  lib/career.js flowOf の結果
 *   career      gw_employee_careers の行 | null
 *   growth      { status, end_date } | null（いちばん新しい3か月育成）
 *   links       { onboard, order, signs, hr, growth, applicant }
 *   canAdvance  採用決定から契約条件の設定へ進めてよい人か（経営者・管理者）
 *   today       'YYYY-MM-DD'
 */
function baseJourney(p) {
  const L = p.links || {};
  const make = (state, label, extra = {}) => ({
    state, stateLabel: extra.stateLabel || JOURNEY_STATES.find((s) => s.key === state)?.label || state,
    step: stepNo(state), total: JOURNEY_STATES.length,
    label, sub: extra.sub || null, cta: extra.cta || null,
    actor: extra.actor || null, actorLabel: ACTOR_LABELS[extra.actor] || null,
    tone: extra.tone || (extra.actor === "employee" || extra.actor === "advisor" ? "yellow" : "blue"),
  });

  // ① 採用決定（まだ社員になっていない）
  if (!p.employee) {
    const a = p.applicant || {};
    if (a.status !== "accepted") {
      return make("hired", "内定の承諾を待っています", { actor: "employee",
        sub: "承諾されたら、契約条件の設定へ進みます", cta: L.applicant ? { key: "link", label: "採用HRで見る", href: L.applicant } : null });
    }
    return make("hired", "契約条件を設定してください", { actor: "owner", tone: "red",
      sub: a.join_date ? `入社予定：${slash(a.join_date)}` : null,
      cta: p.canAdvance && L.onboard ? { key: "link", label: "契約条件を設定", href: L.onboard } : null });
  }

  // ② 〜 ⑦ 入社手続き（手続きがあって、まだ終わっていない）
  const st = p.stage?.key;
  if (p.procedure && st && st !== "complete") {
    if (st === "conditions") {
      return make("contract_setup", "労働条件通知書を作成してください", { actor: "hr", tone: "red",
        stateLabel: "契約条件設定済み", cta: { key: "link", label: "書類を作成", href: L.order } });
    }
    if (st === "advisor_review") {
      const uploaded = p.facts?.order?.status === "uploaded";
      return uploaded
        ? make("document_preparing", "書面が届いています。本人へ送ってください", { actor: "hr",
          cta: { key: "link", label: "本人へ送る", href: L.order } })
        : make("document_preparing", "社労士の確認・発行を待っています", { actor: "advisor",
          cta: { key: "link", label: "作成依頼を見る", href: L.order } });
    }
    if (st === "signing") {
      const signed = p.facts?.sign?.status === "signed" || p.facts?.order?.status === "signed";
      return make("signing", signed ? "誓約書・同意の確認を待っています" : "本人の署名完了を待っています", {
        actor: "employee", stateLabel: "本人署名待ち", cta: { key: "link", label: "署名状況を見る", href: L.signs } });
    }
    // ④ 情報入力・提出。本人の入力 → 本人の書類 → 会社・社労士の確認 の順に1つだけ出す
    const b = intakeBreakdown(p.facts || {});
    if (!b.profileSubmitted) {
      return make("onboarding_info", "入社連絡票の入力待ちです", { actor: "employee", stateLabel: "入社情報未入力",
        sub: "契約締結済み。本人が入社情報を入力します" });
    }
    if (b.employeeOpen || !b.orientationOk) {
      return make("documents_pending", "必要書類の提出を待っています", { actor: "employee",
        sub: b.employeeOpen ? `残り ${b.employeeOpen} 件` : "オリエンテーションの確認がまだです" });
    }
    return make("company_review", "入社手続きを確認してください", { actor: "hr",
      sub: b.internalOpen ? `社内準備が ${b.internalOpen} 件残っています` : null,
      cta: { key: "link", label: "手続きを確認", href: L.hr } });
  }

  // ⑧ キャリア設定
  const cf = p.careerFlow || {};
  const onboarded = Boolean(p.procedure);
  if (!p.career || cf.state === "setup" || cf.state === "meeting") {
    return make("career_setup", "キャリアプランを設定してください", { actor: "manager", tone: "red",
      stateLabel: onboarded ? "入社手続き完了" : "キャリア未設定",
      cta: { key: "meeting", label: p.career ? "面談を続ける" : "キャリア設定" } });
  }
  if (cf.state === "employee_review") {
    return make("career_setup", "本人のキャリアプラン確認を待っています", { actor: "employee",
      stateLabel: "キャリア本人確認待ち", sub: cf.sub });
  }

  // ⑨ 3か月育成（入社手続きから来た人だけ。以前からの社員に「育成を始めて」とは言わない）
  const g = p.growth;
  const growthLive = g && ["draft", "active"].includes(g.status) && (!g.end_date || g.end_date >= p.today);
  if (onboarded && !g) {
    return make("growth_active", "3か月育成を開始してください", { actor: "hr", tone: "red",
      stateLabel: "キャリア設定完了", cta: { key: "growth", label: "3か月育成を開始" } });
  }
  if (growthLive && g.status === "draft") {
    return make("growth_active", "3か月育成計画を確定してください", { actor: "hr",
      cta: { key: "link", label: "3か月育成を開く", href: L.growth } });
  }
  if (growthLive && !["review_due", "contract_preparing", "signing"].includes(cf.state)) {
    return make("growth_active", "3か月育成中です", { actor: "manager", tone: "green",
      sub: g.end_date ? `〜${slash(g.end_date)}` : null, cta: { key: "link", label: "3か月育成を開く", href: L.growth } });
  }

  // ⑩ 通常評価。キャリア側の NEXT ACTION をそのまま使う
  return {
    ...make("active", cf.label || "通常の評価サイクルです", { actor: "manager" }),
    tone: cf.tone || "green", sub: cf.sub || null, cta: cf.cta || null, careerState: cf.state || null,
    stateLabel: cf.stateLabel ? `通常評価（${cf.stateLabel}）` : "通常評価",
  };
}

/**
 * 本人のホームに出す NEXT ACTION（その時点で必要なもの1つだけ）
 * @param {{signPending:number, confirmPending:boolean, stage?:string|null, facts?:object|null}} s
 */
export function memberAskOf({ signPending, confirmPending, stage, facts }) {
  if (signPending && confirmPending) {
    return { key: "contract_career", title: "契約・キャリアの確認があります",
      body: "会社から、現在の契約内容と今後のキャリアプランが届いています。", cta: "確認する", href: "career.html#confirm" };
  }
  if (signPending) {
    return { key: "contract", title: "契約内容の確認があります",
      body: "労働条件通知書が届いています。内容を確認して署名してください。", cta: "契約内容を確認する", href: "contracts.html" };
  }
  if (stage === "intake" && facts) {
    const b = intakeBreakdown(facts);
    if (!b.profileSubmitted) {
      return { key: "info", title: "入社情報を入力してください",
        body: "住所・連絡先・緊急連絡先・給与振込先などを入力します。", cta: "入力する", href: "onboarding.html" };
    }
    if (b.employeeOpen) {
      return { key: "docs", title: "必要書類を提出してください",
        body: `提出が必要な書類が ${b.employeeOpen} 件あります。`, cta: "書類を提出", href: "onboarding.html" };
    }
  }
  if (confirmPending) {
    return { key: "career", title: "キャリアプランの確認があります",
      body: "会社から、今後のキャリアプランが届いています。", cta: "確認する", href: "career.html#confirm" };
  }
  return null;
}

// ---- 共通ステータスバー（管理者と本人が同じものを見る） --------------------------------
//
// 状態（journey.state）は細かいまま。画面では6段階にまとめる。
// 管理者と本人で別々の進捗を持たない：どちらも journeyOf の同じ結果から作る。
// 変わるのは言い方（管理者は担当者名、本人は「あなたの対応です」など）だけ。

export const PHASES = [
  { key: "hired",    label: "採用決定",   states: ["hired"] },
  { key: "contract", label: "契約",       states: ["contract_setup", "document_preparing", "signing"] },
  { key: "self",     label: "本人手続き", states: ["onboarding_info", "documents_pending"] },
  { key: "review",   label: "会社確認",   states: ["company_review"] },
  { key: "career",   label: "キャリア",   states: ["career_setup"] },
  { key: "growth",   label: "育成",       states: ["growth_active", "active"] },
];

/** 6段階それぞれが 完了（done）・現在（now）・未着手（todo）のどれか。通常評価（active）は全部完了 */
export function phasesOf(state) {
  const at = PHASES.findIndex((ph) => ph.states.includes(state));
  const allDone = state === "active";
  return PHASES.map((ph, i) => ({
    key: ph.key, label: ph.label,
    state: allDone || i < at ? "done" : i === at ? "now" : "todo",
  }));
}

/** いま誰の対応か。self＝本人 / company＝会社（人事・上長・経営者）/ advisor＝社労士 / done＝完了 */
export const WHO_TEXT = {
  member: { self: "あなたの対応です", company: "会社が対応中です", advisor: "社労士が確認中です", done: "完了しました" },
};

/**
 * 本人に見せる「現在 / 次にすること / CTA」。管理用語は出さない。
 * 本人の操作が要らないときは CTA を出さない（cta: null）
 */
function memberStepOf(j, p) {
  const none = "現在、あなたの操作は必要ありません。";
  const self = (now, next, label, href) => ({ who: "self", now, next, cta: label ? { label, href } : null });
  const wait = (who, now, next) => ({ who, now, next: `${next}${none}`, cta: null });
  switch (j.state) {
    case "hired":
      return wait("company", "採用決定", "会社が契約の準備をしています。");
    case "contract_setup":
      return wait("company", "契約書の準備", "会社が労働条件通知書（契約書）を準備しています。");
    case "document_preparing":
      return j.actor === "advisor"
        ? wait("advisor", "契約書の準備", "社労士が労働条件通知書を確認しています。")
        : wait("company", "契約書の準備", "会社が労働条件通知書をお送りする準備をしています。");
    case "signing": {
      const signed = p.facts?.sign?.status === "signed" || p.facts?.order?.status === "signed";
      return signed
        ? self("誓約書などの確認", "誓約書・個人情報の取り扱いなどを読んで、確認してください", "確認する", "onboarding.html")
        : self("契約内容の確認・署名", "労働条件通知書を確認して、署名してください", "契約内容を確認する", "contracts.html");
    }
    case "onboarding_info":
      return self("入社情報の入力", "住所・振込口座などを入力してください", "入社情報を入力する", "onboarding.html");
    case "documents_pending":
      return self("必要書類の提出", "本人確認書類など、必要な書類を提出してください", "必要書類を提出する", "onboarding.html");
    case "company_review":
      return wait("company", "会社・社労士確認", "会社が提出内容を確認しています。");
    case "career_setup":
      return j.actor === "employee"
        ? self("キャリアプランの確認", "会社から届いたキャリアプランを確認してください", "キャリアプランを確認する", "career.html#confirm")
        : wait("company", "キャリアプランの準備", "上長があなたのキャリアプランを準備しています。");
    case "growth_active":
      return j.actor === "hr"
        ? wait("company", "3か月育成の準備", "会社が3か月の育成計画を準備しています。")
        : self("3か月育成", "3か月育成の目標に取り組みましょう", "キャリアを見る", "career.html");
    default:
      return { who: "done", now: "入社・キャリア設定", next: "入社からキャリア設定・育成開始まで完了しました。次回評価に向けて取り組みましょう。", cta: null };
  }
}

/** 管理者側の「いま誰の対応か」。本人のものと同じ who から作る */
function adminWhoText(who, actorLabel) {
  if (who === "done") return "完了";
  if (who === "self") return "本人の対応待ち";
  if (who === "advisor") return "社労士が確認中";
  return `${actorLabel || "会社"}が対応`;
}

/**
 * 採用決定 → 契約 → 入社 → キャリア → 育成 の状態。
 * 返す値に、共通ステータスバー（phases・phase）・誰の対応か（who）・本人向けの言い方（member）を含める。
 * 管理画面も本人画面も、この1つの結果だけを見る
 */
export function journeyOf(p) {
  const j = baseJourney(p);
  const member = memberStepOf(j, p);
  const phases = phasesOf(j.state);
  return {
    ...j,
    phases,
    phase: phases.find((x) => x.state === "now")?.key || (j.state === "active" ? "growth" : null),
    who: member.who,
    whoText: { member: WHO_TEXT.member[member.who], admin: adminWhoText(member.who, j.actorLabel) },
    member,
  };
}

