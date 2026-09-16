// 案内の文言が、画面に出ている文言と合っているか。
//
// 片方だけ直すと「聞いた話と画面が違う」が起きる。
// 端末管理はそこが命なので、機械で照らし合わせる。
//
// あわせて「社員向けに出さないと決めたもの」が漏れていないかも見る。
import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);
const { NOTICE, AGENT_NOTICE } = await import(atRoot("api/devices/me.js"));

// 飾りと改行をつぶす。案内では引用として折り返して書いてあるので、
// そのままでは画面の1行と突き合わせられない
/**
 * 社員に見えるところだけを読む。
 *
 * コードのコメントは画面に出ない。混ぜて数えると、
 * 「コメントに しきい値 と書いたから NG」のような、
 * 直しても意味のない指摘が出る。
 */
const read = (p) => {
  let s = readFileSync(p, "utf8");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");      // HTML のコメント
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ");    // ブロックコメント（CSS も）
  s = s.replace(/^\s*\/\/.*$/gm, " ");        // 行コメント
  return s.replace(/[`*]/g, "");
};
const flat = (s) => String(s).replace(/[`*\s>]/g, "");
const doc = read(atRoot("docs/device-guide-for-members.md"));
const consent = read(atRoot("device-consent.html"));
const mypage = read(atRoot("mypage.html"));
const setup = read(atRoot("device-setup.html"));

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const plain = (s) => String(s).replace(/[`*]/g, "");

console.log("— 案内と画面がそろっているか —");
check(flat(doc).includes(flat(NOTICE.lead)), "定型文がそのまま載っている");
for (const a of NOTICE.areas) check(doc.includes(plain(a)), `大分類: ${a}`);
check(doc.includes("私物PCでの業務利用は禁止します"), "私物PCの禁止が書いてある");
check(doc.includes("事前に管理者の承認"), "承認の道があることも書いてある");
check(flat(doc).includes(flat(AGENT_NOTICE.scope).slice(0, 24)), "勤務時間の内と外");

console.log("— 同意ではなく周知になっているか —");
check(/同意を求めるものではありません/.test(NOTICE.ack), "画面が「同意ではない」と言っている");
check(/会社ルール/.test(doc), "案内も会社ルールと書いている");
// 記録する内容の説明は、この画面から外した（依頼）。
// 外した以上、「内容を確認しました」と押させてはいけない。
// 見せていないものを確認した、という記録になる
check(/この端末を登録する/.test(consent), "ボタンが「この端末を登録する」");
check(!/内容を確認しました/.test(consent),
  "見せていない内容を「確認しました」と押させていない");
check(!/このパソコンです/.test(consent), "「このパソコンです」は残っていない");
check(!/監視/.test(consent) && !/監視/.test(setup), "画面に「監視」を出していない");
check(!/同意/.test(consent), "端末の画面に「同意」を出していない");
check(/解除はできません/.test(doc), "解除できないことを案内に書いている");

console.log("— 社員向けに出さないと決めたもの —");
// 社員が読む場所だけを見る。
// 0章（案内の考え方）と 4〜5章（管理者がやること）は管理者向けの手引きなので、
// そこに仕様の話が出るのは当たり前。混ぜると検査にならない
const spoken = doc.slice(doc.indexOf("## 1."), doc.indexOf("## 4."));
const forMembers = [
  JSON.stringify(NOTICE), JSON.stringify(AGENT_NOTICE),
  consent, mypage, setup, spoken,
].join("\n");
// しきい値・検知条件・技術仕様。出すと、避ける方法を配ることになる
const ng = [
  ["90分", /90\s*分/],
  ["しきい値", /しきい値/],
  ["クエリパラメータの削り方", /\? から後ろ|クエリパラメータ|fragment/],
  ["Cookie", /Cookie/],
  ["dedupe", /dedupe/],
  ["24時間で未通信", /24時間以上/],
  ["APIの名前", /gw_device_|api\/devices\//],
  // 保存期間も出さない。何日で消えるか分かると、
  // それに合わせた行動をとる余地が生まれる
  ["保存期間の日数", /90日|保存期間は\s*\d/],
];
for (const [name, re] of ng) {
  check(!re.test(forMembers), `社員向けに出さない: ${name}`);
}

console.log("— 規程のひな形にも、日数を書いていないか —");
const policy = read(atRoot("docs/device-policy-draft.md"));
check(!/90日|\d+日を経過/.test(policy), "規程に保存日数を書いていない");
check(/会社が別に定める/.test(policy), "代わりに「会社が別に定める」としてある");

console.log("— 内部の仕様書には、正確に残っているか —");
const spec = read(atRoot("docs/device-web-history.md"))
           + read(atRoot("docs/device-management.md"));
check(/クエリ|\? から後ろ|パラメータ/.test(spec), "URLの削り方が仕様書にある");
check(/90/.test(spec), "保存期間の日数は、仕様書には書いてある");

console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
