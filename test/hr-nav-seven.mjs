// HR共通ヘッダー（7項目）と、応募者別の面談起動・プロフィールURL・職種候補の判定。ブラウザ不要。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { jobTitleOptions, APPLICANT_JOB_TITLES, normalizeApplicant } from '../lib/hr.js';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ---- ヘッダー ----
function header({ canDecide, active }) {
  const nav = { innerHTML: '', attrs: {}, scrollWidth: 0, clientWidth: 0, setAttribute(k, v) { this.attrs[k] = v; }, querySelector: () => null };
  const removed = [];
  const document = {
    head: { appendChild() {} }, getElementById: () => null, createElement: () => ({}),
    querySelector: sel => sel === '.hr-nav' ? nav : null,
    querySelectorAll: sel => sel === '.hr-actions .hr-manual' ? [{ remove: () => removed.push(sel) }] : [],
  };
  const HRLayout = { esc: s => String(s), init: async () => ({ canRecruit: true, canDecide }) };
  const ctx = vm.createContext({ window: { HRLayout }, HRLayout, document });
  vm.runInContext(read('js/hr-nav-v2.js'), ctx);
  return HRLayout.init({ active }).then(() => {
    const items = [...nav.innerHTML.matchAll(/<a href="([^"]+)" data-nav="([^"]+)" class="([^"]*)"( aria-current="page")?>.*?<\/span>([^<]+)<\/a>/g)]
      .map(m => ({ href: m[1], key: m[2], on: m[3].split(' ').includes('on'), current: Boolean(m[4]), label: m[5] }));
    return { items, removed, HRLayout };
  });
}
const full = await header({ canDecide: true, active: 'home' });
assert.deepEqual(full.items.map(i => i.label), ['ダッシュボード', '応募者管理', '採用判断', '応募分析', '採用資料', 'メールひな型', '操作マニュアル'], '7項目・指定の順');
assert.deepEqual(full.items.map(i => i.href), ['/hr/dashboard.html', '/hr/applicants.html', '/hr/ceo-review.html', '/hr/', '/hr/materials.html', '/hr/templates.html', '/guide-hr-office.html#hr']);
for (const banned of ['その他', '面談ナビ', 'トライアル', '内定・契約']) assert.ok(!full.items.some(i => i.label.includes(banned)), banned + ' はヘッダーに出さない');
assert.equal(full.removed.length, 1, '右側の重複マニュアルボタンは外す');
const limited = await header({ canDecide: false, active: 'applicants' });
assert.deepEqual(limited.items.map(i => i.label), ['ダッシュボード', '応募者管理', '応募分析', '採用資料', 'メールひな型', '操作マニュアル'], '権限が無ければ採用判断は出さない');
// 現在位置（各画面が渡している active → 選択表示）
const expected = { home: 'home', applicants: 'applicants', interviews: 'applicants', trials: 'applicants', contracts: 'applicants', intake: 'applicants', spot: 'applicants', ceo: 'ceo', dashboard: 'analytics', materials: 'materials', templates: 'templates', inbox: 'home', tools: null };
for (const [active, key] of Object.entries(expected)) {
  const r = await header({ canDecide: true, active });
  const on = r.items.filter(i => i.on);
  assert.deepEqual(on.map(i => i.key), key ? [key] : [], `active=${active}`);
  assert.ok(on.every(i => i.current), '選択中は aria-current');
}
// 各画面が実際に渡しているキーが、すべてマッピング済みであること（未知のキーで無選択にならない）
for (const f of fs.readdirSync(new URL('../hr/', import.meta.url)).filter(f => f.endsWith('.html'))) {
  const html = read('hr/' + f);
  const m = html.match(/HRLayout\.init\(\{\s*active:\s*["']([a-z]+)["']/);
  if (!m) continue;
  assert.ok(m[1] in expected, `${f} の active "${m[1]}" の選択先が決まっている`);
  assert.match(html, /hr-nav-v2\.js\?v=20261114seven2"/, `${f} は最新のヘッダーを読む`);
}
assert.match(read('hr/index.html'), /active:"dashboard"/); // 旧キーのまま「応募分析」が選ばれる
// ヘッダーから外した機能の画面と入口が残っていること
for (const f of ['hr/tools.html', 'hr/intake.html', 'hr/spot.html', 'hr/inbox.html', 'hr/interviews.html', 'hr/trials.html', 'hr/contracts.html']) assert.ok(fs.existsSync(new URL('../' + f, import.meta.url)), f + ' は削除しない');
const applicantsHtml = read('hr/applicants.html'), dash = read('hr/dashboard.html');
assert.match(applicantsHtml, /href="\/hr\/intake\.html">応募受付/, '応募者管理に応募受付タブ');
assert.match(applicantsHtml, /spot_register/, '応募者管理にスポット人材への入口');
assert.match(applicantsHtml, /href="\/hr\/inbox\.html"/, '応募者管理に通知履歴');
assert.match(dash, /href="\/hr\/inbox\.html"/, 'ダッシュボードに通知履歴');
assert.match(dash, /href="\/hr\/intake\.html"/, 'ダッシュボードに応募受付');
assert.ok(!/href="\/hr\/interviews\.html"[^?]/.test(dash), 'ダッシュボードから応募者を特定しない面談ナビへは送らない');

// ---- 応募者別の面談起動 ----
const ctx = vm.createContext({ URL }); // ブラウザと同じ URL を渡す
vm.runInContext(read('js/hr-applicant-list.js'), ctx);
const H = ctx.HRApplicantList;
const A = { id: 'applicant-a', stage: 'casual_interview', status: 'interview_scheduled', nextInterviewId: 'iv-a', nextInterviewAt: '2026-11-20T01:00:00Z', nextInterviewKind: 'casual' };
assert.equal(H.listInterview(A).href, '/hr/interviews.html?applicantId=applicant-a&interviewId=iv-a');
assert.equal(H.listInterview({ ...A, nextInterviewAt: null }), null, '予定日時なしは開始を出さない');
assert.equal(H.listInterview({ ...A, nextInterviewId: null }), null, '面談記録なしは開始を出さない');
assert.equal(H.listInterview({ ...A, status: 'eval_pending' }), null, '実施後は開始を出さない');
assert.equal(H.listInterview({ ...A, status: 'declined' }), null, '終了者は開始を出さない');
const ivA = { id: 'iv-a', applicantId: 'applicant-a', kind: 'casual', scheduledAt: A.nextInterviewAt, done: false, canceled: false };
assert.equal(H.detailInterview(A, [ivA]).href, '/hr/interviews.html?applicantId=applicant-a&interviewId=iv-a');
assert.equal(H.detailInterview(A, [{ ...ivA, done: true }]), null, '実施済み');
assert.equal(H.detailInterview(A, [{ ...ivA, canceled: true }]), null, '取消');
assert.equal(H.detailInterview(A, [{ ...ivA, scheduledAt: null }]), null, '日時未定');
assert.equal(H.detailInterview(A, [{ ...ivA, id: 'iv-b' }]), null, '別の面談IDは使わない');
assert.equal(H.detailInterview(A, [{ ...ivA, applicantId: 'applicant-b' }]), null, '別の応募者の面談は使わない');
assert.equal(H.detailInterview(A, []), null, '面談が無ければ架空の面談を作らない');
assert.equal(H.interviewKindLabel('casual'), 'カジュアル面談'); assert.equal(H.interviewKindLabel('ceo'), '最終面談');
// メール未登録でも、主ボタンは面談設定。メール登録は補助
const noMail = { id: 'x', stage: 'applied', status: 'todo', nextActionKey: 'registerEmail', nextActionCta: 'メールアドレスを登録' };
const g = H.guidance(noMail);
assert.equal(g.cta, '面談を設定する'); assert.equal(g.primaryKey, 'scheduleInterview');
assert.equal(g.secondary.key, 'registerEmail'); assert.equal(H.view(noMail).cta, '面談を設定する');
assert.equal(H.guidance({ ...noMail, nextActionKey: 'sendSchedulingLink', nextActionCta: '日程調整を送る' }).secondary, null);

// ---- 内定通知書：自動作成が主導線、アップロードは補助 ----
const offerDraft = { id: 'o', stage: 'offer', status: 'offer_draft_pending', decision: 'hired', offerType: 'executive_employee', nextActionKey: 'createOffer', nextActionCta: 'オファーを作成' };
assert.equal(H.view(offerDraft).cta, 'PDFを作成・確認'); assert.equal(H.guidance(offerDraft).cta, 'PDFを作成・確認');
assert.equal(H.guidance(offerDraft).key, 'createOffer'); assert.match(H.guidance(offerDraft).instruction, /送信されません/);
assert.deepEqual({ ...H.guidance(offerDraft).secondary }, { key: 'uploadOffer', cta: '作成済みPDFをアップロード' });
assert.equal(H.guidance({ ...offerDraft, status: 'offer_review_pending', nextActionKey: 'reviewOffer', nextActionCta: '条件通知書を確認して送る' }).secondary.key, 'uploadOffer');
assert.equal(H.guidance({ ...offerDraft, status: 'offer_send_pending', nextActionKey: 'sendOffer', nextActionCta: '条件通知書を確認して送る' }).secondary, null);
{
  const html = applicantsHtml, flow = read('js/hr-pdf-flow-ui.js');
  assert.match(html, /function openOfferForm\(\) \{ return openGeneratedOfferForm\(\); \}/, 'NEXTは採用条件の入力（自動作成）へ');
  assert.match(html, /id="of-send" onclick="submitOfferAndPreview\(this\)">PDFを作成・確認</);
  const preview = html.slice(html.indexOf('async function submitOfferAndPreview'), html.indexOf('// ---- 内容を確認して、メールで送る'));
  assert.match(preview, /await openOfferSend\(offer\.id\)/, '作成後は中央のプレビューへ');
  assert.ok(preview.length > 200 && !/action:\s*["']send["']|sendOfferManual|submitMarkSent|openSendConfirm/.test(preview), 'PDFの作成では送信しない');
  assert.match(html, /expectedKey==='uploadOffer'\)return openCandidateDocuments\(\)/, 'アップロードは補助として残す');
  assert.equal((flow.match(/data-act="generate">PDFを作成・確認</g) || []).length, 2, 'PDFフロー画面にも自動作成');
  assert.match(flow, /action=uploadDocument/, 'PDFフロー画面のアップロードも残す');
  const gen = flow.slice(flow.indexOf("if(type==='generate')"), flow.indexOf("if(type==='upload')"));
  assert.ok(!/call\('send'/.test(gen) && /generateOffer/.test(gen), '自動作成の操作は送信しない');
}

// ---- プロフィールURL ----
assert.equal(H.safeUrl('https://www.wantedly.com/id/someone'), 'https://www.wantedly.com/id/someone');
for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://example.com/a', '//example.com', 'example.com', 'https://user:pw@example.com/', 'https://localhost/', 'https://example.com/"><script>', ' ', null, 'https://example.com/' + 'a'.repeat(600)])
  assert.equal(H.safeUrl(bad), null, 'reject ' + bad);
assert.equal(H.profileLink('https://www.wantedly.com/id/someone').embed, false, 'Wantedly は埋め込まない');
assert.equal(H.profileLink('https://offerbox.jp/x').embed, false, 'OfferBox は埋め込まない');
assert.equal(H.profileLink('https://portfolio.example.com/me').embed, true);
assert.equal(H.profileLink('http://portfolio.example.com/me').embed, false, 'http は埋め込まず別タブ');
assert.equal(H.profileLink('javascript:alert(1)'), null);

// ---- 職種プルダウン ----
const opts = jobTitleOptions([{ job_title: 'AIまち 運営' }, { job_title: 'AIまち 運営' }, { job_title: ' 営業 ' }, { job_title: '' }]);
assert.equal(opts[0], 'AIまち 運営', '既存の職種名を残す（多い順）');
assert.equal(opts.filter(x => x === '営業').length, 1, '重複しない');
for (const d of APPLICANT_JOB_TITLES) assert.ok(opts.includes(d));
assert.deepEqual(APPLICANT_JOB_TITLES, ['営業', 'エンジニア', 'マーケティング', '広報', '事務', 'カスタマーサポート', 'PM/PMO'], '初期候補');
assert.deepEqual(jobTitleOptions([]), APPLICANT_JOB_TITLES, '登録が無ければ初期候補');
// 将来の管理画面：管理された募集職種を渡すと初期候補の代わりになる。既存の職種名は先頭に残る
assert.deepEqual(jobTitleOptions([{ job_title: '旧職種' }], ['採用担当', ' 営業 ', '']), ['旧職種', '採用担当', '営業']);
assert.deepEqual(jobTitleOptions([], []), APPLICANT_JOB_TITLES, '空の管理一覧では初期候補へ戻る');
assert.deepEqual([...H.jobTitleOptions(['営業', '営業'], [{ jobTitle: '旧職種' }])], ['営業', '旧職種']);
// メール空欄でも登録できる（既存の検証を緩めていない：氏名・職種・媒体は必須のまま）
assert.ok(!normalizeApplicant({ name: '架空', jobTitle: '営業', source: 'Wantedly' }).error);
assert.ok(normalizeApplicant({ name: '架空', jobTitle: '', source: 'Wantedly' }).error);
assert.ok(normalizeApplicant({ name: '架空', jobTitle: '営業', source: 'Wantedly', email: 'not-an-email' }).error);
console.log('PASS HR seven-item header, active mapping, permission-gated decision link, retained entries, applicant-scoped interview launch, interview-first next action without email, profile URL validation and job title options');
