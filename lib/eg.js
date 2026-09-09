// EIGHT GROWTH（growth.8grp.co.jp）のデータを読む。
//
// ■ どこに置くかの決めごと
//   営業のデータは growth 側の Supabase にだけ置く。mf は持たない。
//   同じ数字を2か所で管理すると、どちらが正しいか誰も分からなくなる。
//
//     growth = エンジン（すべてのデータと、詳細な管理画面）
//     mf     = コックピット（今日やることだけ）
//
//   growth のテーブル定義は growth リポジトリの supabase/sales.sql。
//
// ■ なぜ service_role で読むのか
//   growth の RLS は「事務局アカウントでログインした人」を前提にしている。
//   mf のメンバーは growth のアカウントを持たないので、その鍵では通れない。
//   サーバ側（この関数）だけが service_role を持ち、
//   ログインしている本人の分だけに絞ってから返す。鍵はブラウザに出さない。
//
// ■ 担当者はメールアドレスで突き合わせる
//   mf と growth でユーザーIDを揃えるのは手間がかかり、片方が変わると壊れる。
//   両方が確実に持っているメールで繋ぐ（growth 側の owner_email）。

import { createClient } from "@supabase/supabase-js";
import { askJson, aiConfigured } from "./ai-json.js";

const URL = process.env.GROWTH_SUPABASE_URL;
const KEY = process.env.GROWTH_SUPABASE_SERVICE_ROLE_KEY;

export const egConfigured = () => Boolean(URL && KEY);

function gsb() {
  if (!egConfigured()) {
    throw new Error("GROWTH_SUPABASE_URL / GROWTH_SUPABASE_SERVICE_ROLE_KEY が未設定です");
  }
  return createClient(URL, KEY, { auth: { persistSession: false } });
}

// ---- 日付（日本時間）---------------------------------------------------------

export function todayJst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
const dayRangeJst = (d) => ({
  from: new Date(`${d}T00:00:00+09:00`).toISOString(),
  to: new Date(`${d}T23:59:59+09:00`).toISOString(),
});

// ---- 今日の分をまとめて取る --------------------------------------------------

/**
 * ログインしている本人の「今日」を1回で組み立てる。
 * 画面が必要とする分だけを返し、明細は growth の管理画面に任せる。
 *
 * @param {string} email ログイン中のメールアドレス
 * @param {string} date  YYYY-MM-DD（日本時間）
 */
export async function todayFor(email, date = todayJst()) {
  const sb = gsb();
  const { from, to } = dayRangeJst(date);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const mine = (q) => q.eq("owner_email", email);

  const [target, acts, leads, deals, challenges, agencies] = await Promise.all([
    sb.from("sales_targets").select("new_agencies, contacts, meetings, note")
      .eq("owner_email", email).eq("on_date", date).maybeSingle(),

    // 今日の接触
    mine(sb.from("activities").select("id, kind, at").gte("at", from).lte("at", to)),

    // 未対応とフォロー期限。急ぐものから
    mine(sb.from("leads")
      .select("id, name, kind, status, priority, next_action, next_action_on")
      .in("status", ["未対応", "対応中"]))
      .order("next_action_on", { ascending: true, nullsFirst: false })
      .limit(50),

    // 今日の商談
    mine(sb.from("deals").select("id, title, stage, amount, meeting_at")
      .gte("meeting_at", from).lte("meeting_at", to))
      .order("meeting_at", { ascending: true }),

    // 新しく公開されたChallenge（担当に関係なく、全員が知っておくもの）
    sb.from("challenges").select("id, title, tags, updated_at, companies(name)")
      .eq("status", "公開中").gte("updated_at", weekAgo)
      .order("updated_at", { ascending: false }).limit(5),

    // 今日つくった代理店（開拓の実績）
    mine(sb.from("agencies").select("id, name, created_at").gte("created_at", from).lte("created_at", to)),
  ]);

  for (const r of [acts, leads, deals, challenges, agencies]) {
    if (r?.error) throw new Error(`growth の読み取りに失敗しました: ${r.error.message}`);
  }

  const t = target?.data || { new_agencies: 0, contacts: 0, meetings: 0, note: null };
  const leadRows = leads.data || [];
  const overdue = leadRows.filter((l) => l.next_action_on && l.next_action_on <= date);

  return {
    date,
    owner: email,
    target: { newAgencies: t.new_agencies || 0, contacts: t.contacts || 0, meetings: t.meetings || 0, note: t.note || null },
    done: {
      contacts: (acts.data || []).length,
      newAgencies: (agencies.data || []).length,
      meetings: (deals.data || []).length,
    },
    leads: {
      untouched: leadRows.filter((l) => l.status === "未対応").length,
      overdue: overdue.length,
      // 画面には上位だけ。全部は growth の管理画面で見る
      items: [...overdue, ...leadRows.filter((l) => l.status === "未対応" && !overdue.includes(l))]
        .slice(0, 5)
        .map((l) => ({ id: l.id, name: l.name, kind: l.kind, status: l.status,
          priority: l.priority, nextAction: l.next_action, on: l.next_action_on })),
    },
    meetings: (deals.data || []).map((d) => ({
      id: d.id, title: d.title, stage: d.stage, amount: d.amount, at: d.meeting_at,
    })),
    challenges: (challenges.data || []).map((c) => ({
      id: c.id, title: c.title, company: c.companies?.name || null, tags: c.tags || [],
    })),
  };
}

// ---- 記録する ---------------------------------------------------------------

/** 接触を1件つける。今日の接触数はこの積み上げ */
export async function logActivity(email, { kind, summary, leadId, agencyId, dealId }) {
  const sb = gsb();
  const { data, error } = await sb.from("activities").insert({
    owner_email: email, kind: kind || "電話", summary: summary || "",
    lead_id: leadId || null, agency_id: agencyId || null, deal_id: dealId || null,
  }).select().single();
  if (error) throw new Error(`接触の記録に失敗しました: ${error.message}`);
  return data;
}

/** 商談を1件つくる */
export async function createDeal(email, { title, stage, amount, meetingAt, leadId, note }) {
  if (!title || !title.trim()) throw new Error("商談名を入力してください");
  const sb = gsb();
  const { data, error } = await sb.from("deals").insert({
    owner_email: email, title: title.trim(), stage: stage || "初回接触",
    amount: amount || null, meeting_at: meetingAt || null,
    lead_id: leadId || null, note: note || null,
  }).select().single();
  if (error) throw new Error(`商談の登録に失敗しました: ${error.message}`);
  return data;
}

/** リードの次の一手を書き換える（フォロー期限を延ばす／状態を進める） */
export async function updateLead(email, { id, status, nextAction, nextActionOn }) {
  if (!id) throw new Error("リードが指定されていません");
  const sb = gsb();
  const patch = {};
  if (status) patch.status = status;
  if (nextAction !== undefined) patch.next_action = nextAction;
  if (nextActionOn !== undefined) patch.next_action_on = nextActionOn || null;
  const { data, error } = await sb.from("leads").update(patch)
    .eq("id", id).eq("owner_email", email)  // 自分の担当だけ
    .select().single();
  if (error) throw new Error(`リードの更新に失敗しました: ${error.message}`);
  return data;
}

// ---- AI ---------------------------------------------------------------------

export { aiConfigured };

/**
 * 今日の数字を見て、次にやることを3つに絞る。
 *
 * ここはAIに任せてよいところ。何を目指すか（目標）は人が決めていて、
 * AIがするのは「残っている中でどれから手を付けるか」の並べ替えだけ。
 * AIの鍵が無いときは、同じ判断をルールで返す。
 */
export async function suggestActions(today, { useAi = true } = {}) {
  const rules = ruleActions(today);
  if (!useAi || !aiConfigured()) return { source: "rule", items: rules };

  const material = [
    `日付: ${today.date}`,
    `目標: 代理店開拓 ${today.target.newAgencies}件 / 接触 ${today.target.contacts}件 / 商談 ${today.target.meetings}件`,
    `実績: 代理店 ${today.done.newAgencies}件 / 接触 ${today.done.contacts}件 / 商談 ${today.done.meetings}件`,
    `未対応リード ${today.leads.untouched}件、フォロー期限ぎれ ${today.leads.overdue}件`,
    today.leads.items.length
      ? "急ぐリード:\n" + today.leads.items.map((l) => `- ${l.name}（${l.kind}／${l.status}／期限 ${l.on || "未設定"}／次: ${l.nextAction || "未設定"}）`).join("\n")
      : "急ぐリードなし",
    today.meetings.length
      ? "今日の商談:\n" + today.meetings.map((m) => `- ${m.title}（${m.stage}）`).join("\n")
      : "今日の商談なし",
    today.challenges.length
      ? "新しく公開されたChallenge:\n" + today.challenges.map((c) => `- ${c.title}${c.company ? `（${c.company}）` : ""}`).join("\n")
      : "新しいChallengeなし",
  ].join("\n");

  try {
    const { result } = await askJson(
      "あなたは代理店開拓の営業チームの相棒です。今日これから手を付ける順に3つだけ挙げます。" +
        "抽象論は書かず、誰に何をするかを1文で書きます。数字を作らず、渡された材料だけを使います。",
      material,
      {
        type: "object",
        properties: {
          items: {
            type: "array", maxItems: 3,
            items: {
              type: "object",
              properties: { text: { type: "string" }, why: { type: "string" } },
              required: ["text"],
            },
          },
        },
        required: ["items"],
      },
      "next_actions",
      "short"
    );
    const items = (result.items || []).slice(0, 3).map((x) => ({ text: x.text, why: x.why || "" }));
    return items.length ? { source: "ai", items } : { source: "rule", items: rules };
  } catch {
    // AIが落ちても、今日の仕事は止めない
    return { source: "rule", items: rules };
  }
}

/** AIが使えないときの並べ替え。急ぎと、目標に足りない分から */
function ruleActions(t) {
  const out = [];
  if (t.leads.overdue) {
    const l = t.leads.items[0];
    out.push({ text: `フォロー期限を過ぎたリードが${t.leads.overdue}件。まず「${l?.name || ""}」に連絡する`, why: "期限ぎれから先に片づける" });
  }
  if (t.meetings.length) {
    out.push({ text: `今日の商談「${t.meetings[0].title}」の準備をする`, why: "時間が決まっているものを外さない" });
  }
  const left = t.target.contacts - t.done.contacts;
  if (left > 0) out.push({ text: `接触があと${left}件。未対応リードから順に当たる`, why: "今日の目標に足りない分" });
  const agLeft = t.target.newAgencies - t.done.newAgencies;
  if (agLeft > 0) out.push({ text: `代理店の新規開拓があと${agLeft}件`, why: "今日の目標に足りない分" });
  if (t.challenges.length) {
    out.push({ text: `新しいChallenge「${t.challenges[0].title}」を提案材料に使う`, why: "話のきっかけになる" });
  }
  if (!out.length) out.push({ text: "今日の目標は達成。明日のリードを仕込む", why: "" });
  return out.slice(0, 3);
}

/** 企業をAIで下調べする。営業前に何を聞くかを決めるためのもの */
export async function analyzeCompany({ name, url, note }) {
  if (!aiConfigured()) throw new Error("AIの鍵が設定されていません");
  if (!name || !name.trim()) throw new Error("企業名を入力してください");
  const { result } = await askJson(
    "あなたは代理店開拓の営業担当です。渡された情報だけから、初回接触の準備メモを作ります。" +
      "調べていないことを推測で断定しません。分からないことは「確認したいこと」に回します。",
    [`企業名: ${name}`, url ? `URL: ${url}` : "", note ? `メモ: ${note}` : ""].filter(Boolean).join("\n"),
    {
      type: "object",
      properties: {
        summary: { type: "string" },
        fit: { type: "string" },
        hooks: { type: "array", items: { type: "string" }, maxItems: 4 },
        questions: { type: "array", items: { type: "string" }, maxItems: 4 },
      },
      required: ["summary", "fit", "hooks", "questions"],
    },
    "company_brief",
    "short"
  );
  return result;
}

/** 営業メールの下書き。送る前に必ず本人が直す前提 */
export async function draftEmail({ to, company, purpose, tone }) {
  if (!aiConfigured()) throw new Error("AIの鍵が設定されていません");
  if (!company || !company.trim()) throw new Error("宛先の企業名を入力してください");
  const { result } = await askJson(
    "あなたは日本語のビジネスメールを書きます。誇張せず、押し付けず、相手の負担が軽い長さにします。" +
      "実績や数字を作りません。EIGHT GROWTH は、企業・自治体の課題とスタートアップをつなぎ、" +
      "PoCから事業化まで一緒に進める共創プラットフォームです。",
    [`宛先企業: ${company}`, to ? `宛名: ${to}` : "", `目的: ${purpose || "代理店提携の打診"}`,
      `トーン: ${tone || "丁寧・簡潔"}`].filter(Boolean).join("\n"),
    {
      type: "object",
      properties: { subject: { type: "string" }, body: { type: "string" } },
      required: ["subject", "body"],
    },
    "sales_email",
    "short"
  );
  return result;
}
