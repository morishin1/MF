// 採用HR 改善（2026-10-16）Phase 1 の画面：
//   1. メールが送れないとき、担当者向けの理由（メール未登録・送信設定の不足）を両方出し、管理者向けの詳細は折りたたむ
//   2. 送信画面から、その場でメールアドレスを登録できる（登録後は送れる状態に戻る）
//   3. 送信記録に宛先・失敗理由が出る。サーバーの時間切れ（504 の HTML）は「送れたか確認」の案内になる
//   4. 応募一覧は 6つの採用区分タブ ＋ 表示範囲（すべての採用区分／未設定／終了した人／無限道場の受付）。区分タブはその区分の人だけ・終了は混ざらない
//   5. 区分・段階・検索は、再読み込み（詳細から戻る）でも保たれる。終了タブから開いて戻っても選考中へ戻らない
// サーバは偽物（page.route）。実際のメールは送らない。
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const A1 = "11111111-1111-4111-8111-111111111111";
const ME = { email: "recruit@example.jp", appRole: "member", isAdmin: false, shows: {}, access: { recruit: true },
  gw: { employee: { id: "e-hr", display_name: "人事 花子", status: "active" }, roles: ["hr"], isAdmin: false, tenantId: "t1", stage: null } };
const RENDER = { templateId: "t-std", templateVersion: 1, templateName: "応募受付", subject: "ご応募ありがとうございます", body: "山田 様\n本文", missing: [], unknown: [] };
const TEMPLATES = [{ id: "t-std", name: "応募受付", purpose: "application", purposeLabel: "応募受付", active: true, isDefault: true, version: 1 }];
const row = (o) => ({ jobTitle: "エンジニア", source: "Wantedly", stage: "applied", stageLabel: "新規応募", status: "todo", statusLabel: "未対応",
  nextAction: "対応を進めてください", rank: null, leadCategory: "recruitment", ...o });

async function openPage({ applicants, mailState, postMode = "sent", url = "/hr/applicants.html" }) {
  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => { try { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@example.jp" })); } catch { /* sandbox付きiframe */ } });
  const errs = [], patches = [], posts = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.route("**/api/**", async (route) => {
    const req = route.request(), u = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(u)) return send(ME);
    if (/\/api\/hr\/applicants\/mail/.test(u)) {
      if (req.method() === "POST") {
        posts.push(JSON.parse(req.postData() || "{}"));
        if (postMode === "gateway") return route.fulfill({ status: 504, contentType: "text/html", body: "<html>Gateway Timeout</html>" });
        return send({ status: "sent" });
      }
      return send({ applicant: { id: A1, name: "山田 太郎", email: mailState.email, jobTitle: "エンジニア" },
        templates: TEMPLATES, rendered: RENDER, fields: [], sends: mailState.sends || [], mail: mailState.mail });
    }
    if (/\/api\/hr\/applicants\/detail/.test(u)) {
      if (req.method() === "PATCH") {
        const b = JSON.parse(req.postData() || "{}");
        patches.push(b);
        if (b.email) {   // 登録されたら、送れる状態に変わる
          mailState.email = b.email;
          mailState.mail = { configured: true, hasEmail: true, systemConfigured: true, reasons: [], systemReason: null, from: "採用 <recruit@example.jp>" };
        }
        return send({ applicant: { id: A1, email: b.email } });
      }
      return send({ applicant: { ...applicants[0], email: mailState?.email ?? null }, timeline: [], interviews: [], offers: [] });
    }
    if (/\/api\/hr\/applicants\b/.test(u)) return send({ applicants });
    if (/\/api\/notifications/.test(u)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}${url}`);
  await page.waitForTimeout(900);
  return { page, errs, patches, posts };
}

console.log("\n=== メール：送れない理由（2つ）と、その場でのメール登録 ===");
{
  const mailState = { email: null, sends: [
      { id: "s1", status: "failed", subject: "以前の案内", templateName: "応募受付", templateVersion: 1, sentByName: "人事 花子",
        createdAt: "2026-10-10T02:00:00Z", toEmail: "old@example.jp", from: "採用 <recruit@example.jp>", error: "SMTP 認証 で失敗しました（535）" }],
    mail: { configured: false, hasEmail: false, systemConfigured: false,
      reasons: [{ key: "no_email", text: "応募者のメールアドレスが登録されていません。下の欄から登録できます" },
        { key: "not_configured", text: "このシステムのメール送信の設定がまだ完了していません。管理者に連絡してください" }],
      systemReason: "MAIL_SEND_ENABLED=1 になっていないため、実送信は止まっています", from: null } };
  const { page, errs, patches } = await openPage({ applicants: [row({ id: A1, name: "山田 太郎" })], mailState, url: `/hr/applicants.html?id=${A1}` });
  // ?id= は対応モーダルを開く。［メールを送る］は応募者詳細のヘッダー（「応募者情報」から開く）
  await page.waitForSelector("#hr-detail-box.hr-work-modal #hr-work-link-info");
  await page.click("#hr-work-link-info");
  await page.waitForSelector(".hr-detail #hr-mail-btn");
  await page.click("#hr-mail-btn");
  await page.waitForSelector("[data-mail-blocked]");
  const banner = await page.locator("[data-mail-blocked]").innerText();
  check(banner.includes("メールアドレスが登録されていません") && banner.includes("管理者に連絡"), "送れない理由を2つとも出す（メール未登録・送信設定）");
  check(await page.locator("[data-mail-blocked] details").count() === 1 && !(await page.locator("[data-mail-blocked] details").evaluate((d) => d.open)),
    "設定名（管理者向けの詳細）は折りたたみ");
  check(await page.locator("#mail-send").isDisabled(), "送れない間は［送信］を押せない");
  const hist = await page.locator("#mail-history").textContent();   // 折りたたみの中なので textContent
  check(hist.includes("old@example.jp") && hist.includes("535"), "送信記録に宛先と失敗理由が出る");
  check(await page.locator("[data-mail-email-form]").count() === 1, "送信画面にメールアドレスの登録欄が出る");
  await page.fill("#mail-email-input", "not-mail");
  await page.click("[data-mail-email-form] button");
  await page.waitForTimeout(200);
  check((await page.locator("#mail-email-msg").innerText()).includes("形式"), "形式違いはその場で止める");
  await page.fill("#mail-email-input", "taro@example.jp");
  await page.click("[data-mail-email-form] button");
  await page.waitForTimeout(800);
  check(patches.some((p) => p.id === A1 && p.email === "taro@example.jp"), "登録は応募者の更新（PATCH detail）で送る");
  check((await page.locator("#mail-to-email").innerText()).includes("taro@example.jp"), "登録後の宛先が出る");
  check(!(await page.locator("#mail-send").isDisabled()), "登録して設定もあれば、そのまま送れる");
  check(!errs.length, `画面のエラーなし（${errs.join(" / ")}）`);
  await page.close();
}

console.log("\n=== メール：サーバーの時間切れ（504 の HTML）は「送れたか確認」 ===");
{
  const mailState = { email: "taro@example.jp", sends: [],
    mail: { configured: true, hasEmail: true, systemConfigured: true, reasons: [], systemReason: null, from: "採用 <recruit@example.jp>" } };
  const { page, posts } = await openPage({ applicants: [row({ id: A1, name: "山田 太郎" })], mailState, postMode: "gateway", url: `/hr/applicants.html?id=${A1}` });
  // ?id= は対応モーダルを開く。［メールを送る］は応募者詳細のヘッダー（「応募者情報」から開く）
  await page.waitForSelector("#hr-detail-box.hr-work-modal #hr-work-link-info");
  await page.click("#hr-work-link-info");
  await page.waitForSelector(".hr-detail #hr-mail-btn");
  await page.click("#hr-mail-btn");
  await page.waitForSelector("#mail-send");
  await page.click("#mail-send");
  await page.waitForTimeout(800);
  const m = await page.locator("#mail-msg").innerText();
  check(posts.length === 1 && /504/.test(m) && m.includes("送れたかどうか"), "504 のときは結果不明として、送信記録の確認を案内する");
  const key1 = posts[0].requestKey;
  await page.click("#mail-send");
  await page.waitForTimeout(600);
  check(posts.length === 2 && posts[1].requestKey === key1, "送り直しは同じ鍵（送れていれば2通目にならない）");
  await page.close();
}

console.log("\n=== 一覧：採用区分タブ・表示範囲（すべて／終了した人）と、戻ったときの保持 ===");
{
  const list = [
    row({ id: "a1", name: "正社員 一郎", listTab: "active", employmentType: "正社員" }),
    // 区分タブは、記録された採用区分（offerType）だけで絞り込む（契約形態 employmentType では分けない）
    row({ id: "a2", name: "委託 二郎", listTab: "contractor", employmentType: "業務委託", offerType: "contractor" }),
    row({ id: "a3", name: "見送り 三郎", listTab: "closed", status: "passed", statusLabel: "見送り" }),
    row({ id: "a4", name: "辞退 四郎", listTab: "closed", status: "declined", statusLabel: "辞退" }),
  ];
  const { page, errs } = await openPage({ applicants: list, mailState: null });
  // 旧「選考中／業務委託／無限道場／終了」の4タブは、6つの採用区分タブ ＋ 表示範囲（#category-scope）に分かれた
  const tabs = await page.locator("#cat-tabs button").evaluateAll((xs) => xs.map((x) => `${x.dataset.category}:${x.querySelector(".n").textContent}`));
  check(tabs.join("|") === "executive_employee:0|trial_2weeks:0|training:0|contractor:1|part_time:0|spot:0", `区分タブと件数（いま ${tabs.join(" | ")}）`);
  const scope = await page.locator("#category-scope option").evaluateAll((xs) => xs.map((x) => `${x.value}=${x.textContent}`));
  check(scope.some((t) => /^active=すべての採用区分（2）/.test(t)) && scope.some((t) => /^unassigned=採用区分が未設定（1）/.test(t))
    && scope.some((t) => /^closed=終了した人（2）/.test(t)) && scope.some((t) => /^mugendojo=無限道場の受付（0）/.test(t)),
    `表示範囲と件数（いま ${scope.join(" | ")}）`);
  let rows = await page.locator("#rows").innerText();
  // 既定は「すべての採用区分」。業務委託も含めて選考中の人を出す（区分で分けるのは区分タブ）。終了は混ざらない
  check(await page.locator("#category-scope").inputValue() === "active" && rows.includes("正社員 一郎") && rows.includes("委託 二郎")
    && !rows.includes("見送り 三郎") && !rows.includes("辞退 四郎"), "既定はすべての採用区分（終了は混ざらない）");
  await page.selectOption("#category-scope", "unassigned");
  await page.waitForTimeout(300);
  rows = await page.locator("#rows").innerText();
  check(rows.includes("正社員 一郎") && !rows.includes("委託 二郎"), "採用区分が未設定の人だけに絞れる（業務委託は混ざらない）");
  await page.locator('#cat-tabs button[data-category="contractor"]').click();
  await page.waitForTimeout(300);
  rows = await page.locator("#rows").innerText();
  check(rows.includes("委託 二郎") && !rows.includes("正社員 一郎"), "業務委託タブは業務委託の人だけ");
  check((await page.locator("#cat-tabs button.on").getAttribute("data-category")) === "contractor", "選んだ区分タブが選択中になる");
  await page.selectOption("#category-scope", "closed");
  await page.waitForTimeout(300);
  await page.locator('#stage-tabs button[data-stage="status:declined"]').click();
  await page.waitForTimeout(200);
  await page.fill("#q", "辞退");
  await page.waitForTimeout(200);
  // 詳細を開いて戻る（＝再読み込み）と、終了タブ・辞退・検索のまま
  await page.reload();
  await page.waitForTimeout(1000);
  check(await page.locator("#category-scope").inputValue() === "closed" && !(await page.locator("#cat-tabs button.on").count()),
    "再読み込みしても「終了した人」のまま（すべての採用区分へ戻らない）");
  check((await page.locator('#stage-tabs button[data-stage="status:declined"]').getAttribute("class") || "").includes("on"), "段階（辞退）も保つ");
  check((await page.locator("#q").inputValue()) === "辞退", "検索語も保つ");
  rows = await page.locator("#rows").innerText();
  check(rows.includes("辞退 四郎") && !rows.includes("見送り 三郎"), "保った条件で絞り込まれている");
  check(!errs.length, `画面のエラーなし（${errs.join(" / ")}）`);
  await page.close();
}

await br.close();
console.log(bad ? `\nNG ${bad} 件` : "\nすべて通過");
process.exit(bad ? 1 : 0);
