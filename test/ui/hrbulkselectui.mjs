// 採用HR：応募者一覧の複数選択・一括操作を、実際のブラウザで通す。
//
// ■ 何を守るテストか（採用HR応募者一覧・ドロワーUI改善指示書 §1・§2・§5・§6）
//
//   1. チェックボックスで複数選択でき、選んだ分だけ操作バーが出る
//   2. 全選択は「いま表示している分」だけを対象にする（絞り込み中に全DBを巻き込まない）
//   3. チェックボックスを押しても、行の詳細ドロワーは開かない
//   4. ステータス変更・担当変更・削除はモーダルで実行する（ドロワーの上に重ねない）
//   5. 削除の確認は、1名なら氏名・メール、複数なら人数を出す
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const RECRUITER = { id: "emp-r1", display_name: "採用 花子", status: "active" };
const ME = { email: "recruit@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: RECRUITER, roles: ["recruiter"], isAdmin: false, tenantId: "t1", stage: null } };

function applicant(over) {
  return {
    id: over.id, name: over.name, jobTitle: "エンジニア", source: "リファラル",
    stage: "applied", stageLabel: "新規応募", status: "todo", statusLabel: "未対応",
    nextAction: "カジュアル面談の日程を調整してください", nextActionCta: "日程調整を送る",
    nextActionKey: "sendSchedulingLink", rank: null, decisionDueOn: null, recruiterName: null,
    ...over,
  };
}

console.log("\n=== 複数選択・一括操作 ===");
{
  const applicants = [
    applicant({ id: "a1", name: "山田 太郎", email: "yamada@example.jp" }),
    applicant({ id: "a2", name: "佐藤 花子", email: "sato@example.jp" }),
    applicant({ id: "a3", name: "鈴木 次郎", email: "" }),
  ];
  const employees = [{ id: "emp-x", display_name: "面接 一郎" }];
  const bulkPosted = [];

  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/applicants\/bulk/.test(url)) {
      const b = JSON.parse(req.postData() || "{}");
      bulkPosted.push(b);
      if (b.action === "delete") return send({ deleted: b.ids.length });
      return send({ updated: b.ids.length });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      const id = new URL(url).searchParams.get("id");
      const a = applicants.find((x) => x.id === id);
      return send({ applicant: a, interviews: [], timeline: [], offers: [] });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants, employees });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });

  await page.goto(`${BASE}/hr/applicants.html`);
  await page.waitForTimeout(1000);

  console.log("\n— 何も選んでいなければ、操作バーは出ない —");
  check((await page.locator("#bulkbar").innerText()).trim() === "", "操作バーが空");

  console.log("\n— 2名選ぶと、操作バーが出る —");
  const rows = page.locator("#rows tr");
  await rows.nth(0).locator('td input[type="checkbox"]').check();
  await rows.nth(1).locator('td input[type="checkbox"]').check();
  await page.waitForTimeout(150);
  check((await page.locator(".hr-bulkbar .cnt").innerText()).includes("2名選択中"), "件数が出る");
  check(await page.locator(".hr-bulkbar button", { hasText: "ステータス変更" }).count() === 1, "ステータス変更ボタン");
  check(await page.locator(".hr-bulkbar button", { hasText: "担当変更" }).count() === 1, "担当変更ボタン");
  check(await page.locator(".hr-bulkbar button", { hasText: "削除" }).count() === 1, "削除ボタン");
  check(await page.locator(".hr-bulkbar button", { hasText: "選択解除" }).count() === 1, "選択解除ボタン");

  console.log("\n— チェックボックスを押しても、詳細ドロワーは開かない —");
  check(await page.locator(".hr-detail").count() === 0, "ドロワーは開いていない");

  console.log("\n— 行をクリックすると、詳細ドロワーは開く —");
  await rows.nth(2).locator("td").nth(1).click();
  await page.waitForTimeout(500);
  check(await page.locator(".hr-detail").isVisible(), "行クリックではドロワーが開く");
  await page.locator(".hr-detail button", { hasText: "閉じる" }).click();
  await page.waitForTimeout(200);

  console.log("\n— 選択解除 —");
  await page.locator(".hr-bulkbar button", { hasText: "選択解除" }).click();
  await page.waitForTimeout(150);
  check((await page.locator("#bulkbar").innerText()).trim() === "", "操作バーが消える");
  check(!(await rows.nth(0).locator('td input[type="checkbox"]').isChecked()), "チェックも外れる");

  console.log("\n— 全選択は、いま表示している分だけを対象にする —");
  await page.fill("#q", "山田");
  await page.waitForTimeout(150);
  check(await rows.count() === 1, "絞り込みで1件だけ表示");
  await page.locator("#chk-all").check();
  await page.waitForTimeout(150);
  check((await page.locator(".hr-bulkbar .cnt").innerText()).includes("1名選択中"), "絞り込み中の全選択は1名だけ");
  await page.fill("#q", "");
  await page.waitForTimeout(150);
  check((await page.locator(".hr-bulkbar .cnt").innerText()).includes("1名選択中"),
    "絞り込みを解除しても、選択自体は増えない（表示外を巻き込んでいない）");
  await page.locator(".hr-bulkbar button", { hasText: "選択解除" }).click();
  await page.waitForTimeout(150);

  console.log("\n— ステータス変更（モーダル） —");
  await rows.nth(0).locator('td input[type="checkbox"]').check();
  await page.locator(".hr-bulkbar button", { hasText: "ステータス変更" }).click();
  await page.waitForTimeout(300);
  check(await page.locator(".hr-modal").isVisible(), "モーダルで開く");
  await page.selectOption("#bs-status", "passed");
  await page.locator(".hr-modal button", { hasText: "変更する" }).click();
  await page.waitForTimeout(500);
  const st = bulkPosted.find((b) => b.action === "setStatus");
  check(Boolean(st), "setStatusが送られる");
  check(st && st.status === "passed" && st.ids.length === 1, `送った内容（${JSON.stringify(st)}）`);
  check(await page.locator(".hr-modal").count() === 0, "モーダルが閉じる");
  check((await page.locator("#bulkbar").innerText()).trim() === "", "選択も解除される");

  console.log("\n— 担当変更（モーダル） —");
  await rows.nth(0).locator('td input[type="checkbox"]').check();
  await rows.nth(1).locator('td input[type="checkbox"]').check();
  await page.locator(".hr-bulkbar button", { hasText: "担当変更" }).click();
  await page.waitForTimeout(300);
  check(await page.locator("#br-recruiter option", { hasText: "面接 一郎" }).count() === 1, "担当者の選択肢が出る");
  await page.selectOption("#br-recruiter", "emp-x");
  await page.locator(".hr-modal button", { hasText: "変更する" }).click();
  await page.waitForTimeout(500);
  const rc = bulkPosted.find((b) => b.action === "setRecruiter");
  check(Boolean(rc) && rc.recruiterId === "emp-x" && rc.ids.length === 2, `送った内容（${JSON.stringify(rc)}）`);

  console.log("\n— 削除（1名。氏名・メールを出す） —");
  await rows.nth(0).locator('td input[type="checkbox"]').check();
  await page.locator(".hr-bulkbar button", { hasText: "削除" }).click();
  await page.waitForTimeout(300);
  const modalText = await page.locator(".hr-modal").innerText();
  check(modalText.includes("山田 太郎"), "氏名が出る");
  check(modalText.includes("yamada@example.jp"), "メールが出る");
  await page.locator(".hr-modal button", { hasText: "削除する" }).click();
  await page.waitForTimeout(500);
  const del1 = bulkPosted.filter((b) => b.action === "delete").at(-1);
  check(Boolean(del1) && del1.ids.length === 1, "1名削除が送られる");

  console.log("\n— 削除（複数。人数を明示する） —");
  await rows.nth(0).locator('td input[type="checkbox"]').check();
  await rows.nth(1).locator('td input[type="checkbox"]').check();
  await page.locator(".hr-bulkbar button", { hasText: "削除" }).click();
  await page.waitForTimeout(300);
  const modalText2 = await page.locator(".hr-modal").innerText();
  check(modalText2.includes("2名の応募者を削除します"), `人数が出る（${modalText2.slice(0, 40)}）`);
  await page.locator(".hr-modal button", { hasText: "キャンセル" }).click();
  await page.waitForTimeout(200);
  check(await page.locator(".hr-modal").count() === 0, "キャンセルで何も送らずに閉じる");

  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
