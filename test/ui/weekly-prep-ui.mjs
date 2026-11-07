// KEIEI週次PREPの操作導線：MD出力 → AI結果貼り付け → 下書き → 公開 → 本人ホーム。
import { launch, BASE } from "../_browser.mjs";
const br = await launch();
const errors = [];
const who = "11111111-1111-4111-8111-111111111111";
const employee = "22222222-2222-4222-8222-222222222222";
const week = "2026-11-02";
const next = "2026-11-08";
const fields = {
  conclusion: "売上に直結する提案を増やした",
  reason: "提案数の目標3に対して実績4",
  evidence: "11/3 A社への提案4件",
  recommendation: "確認しながら商談化を増やす",
  good_points: "4件の提案を実施",
  improvement_points: "返信待ちを3営業日以内に追客",
  next_actions: "11/13までに5社へ提案",
};
const store = { draft: null, published: null, sent: [] };
const ok = (cond, label) => { if (!cond) throw Error("NG: " + label); console.log("OK: " + label); };
const sample = {
  weekStart: week, weekEnd: next, previousStart: "2026-10-26", today: "2026-11-07",
  summary: { total: 1, written: 1, complete: 1, notWritten: 0, submittedDays: 4, kgiAchieved: 2, kgiRecorded: 3, kgiRate: 67 },
  departments: ["営業"], note: "日報の本人申告を集計",
  members: [{
    employeeId: employee, name: "架空社員", department: "営業", reviewStatus: "filled", needsDiscussion: true,
    submittedDays: 4, kgiAchieved: 2, kgiRecorded: 3, kgiRate: 67, resultsCount: 3,
    topics: ["来週の優先順位を決める"],
    review: { q1: "提案した", q2: "送信を増やした", q3: "追客する", q4: "商談2件" },
    previousReview: { q3: "毎朝提案先を確認", q4: "提案3件" },
    results: [], unfinished: [], consultations: [], improvements: [], kgiDays: [],
  }],
};
function handleApi(route, member = false) {
  const u = new URL(route.request().url());
  const send = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  if (u.pathname === "/api/me") return send({
    appRole: member ? "member" : "owner", isAdmin: false,
    email: member ? "member@example.com" : "owner@example.com", roles: member ? ["member"] : ["owner"],
    gw: { roles: member ? ["member"] : ["owner"], tenantId: "t1", employee: { id: member ? employee : who, display_name: member ? "架空社員" : "架空経営者", status: "active" } },
    access: { keiei: !member, office: !member, marketing: false, home: true },
  });
  if (u.pathname === "/api/keiei" && u.searchParams.get("view") === "weekly") return send(sample);
  if (u.pathname === "/api/keiei/weekly-prep") {
    if (route.request().method() === "POST") {
      const b = route.request().postDataJSON(); store.sent.push(b);
      if (b.action === "withdraw") store.published = null;
      else {
        const nextRow = { ...fields, ...Object.fromEntries(Object.entries(b).filter(([k])=>k in fields)),
          updatedAt: new Date().toISOString(), publishedAt: b.action === "publish" ? new Date().toISOString() : null };
        store[b.action === "publish" ? "published" : "draft"] = nextRow;
      }
      return send({ ok: true });
    }
    if (u.searchParams.get("mode") === "export") {
      return send({ filename: "eight_nippo_PREP.md", markdown: "# PREP分析\n## 良かった点\n- 4件の提案", count: { employees: 1, reports: 4 } });
    }
    return send({ draft: store.draft, published: store.published });
  }
  if (u.pathname === "/api/nippo/feedback") return send({ latest: store.published, history: store.published
    ? [{ ...store.published, periodStart: week, periodEnd: next }] : [] });
  if (u.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
  if (u.pathname.startsWith("/api/")) return send({});
  return route.continue();
}
const page = await br.newPage({ viewport: { width: 1280, height: 850 }, timezoneId: "Asia/Tokyo", acceptDownloads: true });
page.on("pageerror", e => errors.push(String(e)));
page.on("dialog", d => d.accept());
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "owner@example.com" }));
  localStorage.removeItem("kp_layout");localStorage.removeItem("kp_me");
});
await page.route("**/api/**", r => handleApi(r, false));
await page.goto(BASE + "/keiei/#weekly");
await page.locator("#kw-prep-export").waitFor({ timeout: 12000 });
ok((await page.locator("#kw-prep-toolbar").innerText()).includes("PREP"), "経営の分析導線が表示");
const [dl] = await Promise.all([page.waitForEvent("download"),page.click("#kw-prep-export")]);
ok((await dl.suggestedFilename()).endsWith(".md"), "PREPのMarkdownダウンロード");
await page.locator("#kw-prep-raw").fill([
  "## 結論（Point）", fields.conclusion,
  "## 理由（Reason）", fields.reason,
  "## 具体例・根拠（Example）", fields.evidence,
  "## 再結論・改善提案（Point）", fields.recommendation,
  "## 良かった点", fields.good_points,
  "## 改善点", fields.improvement_points,
  "## 来週の行動", fields.next_actions,
].join("\n"));
await page.click("#kw-prep-extract");
ok((await page.locator("#kw-prep-good_points").inputValue()) === fields.good_points, "PREP見出しから良かった点を抽出");
await page.click("#kw-prep-save");
await page.waitForFunction(() => document.querySelector("#kw-prep-editor-message")?.textContent?.includes("下書き"));
ok(store.sent.some(x=>x.action==="save"),"下書きがサーバへ送られた");
await page.click("#kw-prep-publish");
await page.waitForFunction(() => document.querySelector("#kw-prep-editor-message")?.textContent?.includes("公開"));
ok(store.sent.some(x=>x.action==="publish"),"確認後に本人へ公開した");

const member = await br.newPage({ viewport: { width: 980, height: 800 }, timezoneId: "Asia/Tokyo" });
member.on("pageerror", e=>errors.push(String(e)));
await member.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token:"x", email:"member@example.com" }));
  localStorage.removeItem("kp_layout");localStorage.removeItem("kp_me");
});
await member.route("**/api/**", r=>handleApi(r,true));
await member.goto(BASE + "/home.html");
await member.locator("#home-weekly-feedback:not([hidden])").waitFor({timeout:12000});
const card = await member.locator("#home-weekly-feedback").innerText();
ok(card.includes(fields.good_points) && card.includes(fields.improvement_points) && card.includes(fields.next_actions),
  "本人のホームに良かった点・改善点・来週の行動を表示");
ok(errors.length===0,"ブラウザエラーなし: "+errors.join(" | "));
await member.close();await page.close();await br.close();
console.log("Weekly PREP owner-to-member flow PASS");
