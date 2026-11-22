import { redact } from './enger-talent-public.js';

export const WEIGHTS = Object.freeze({ relationship: 25, grip: 25, fit: 30, terms: 20 });
export const POLICY_VERSION = 1;
export const TERM_LABELS = { rate: '単価', start: '開始日', location: '勤務地・働き方', flow: '商流' };
export const FACT_OPTIONS = {
  contact: ['', 'direct', 'staff', 'mail'],
  hiring: ['', 'confirmed', 'stopped'],
  budget: ['', 'yes', 'no'],
  candidateContact: ['', 'direct', 'affiliate', 'sheet'],
  intent: ['', 'yes', 'no'],
  dates: ['', 'yes', 'no'],
  offers: ['', 'none', 'pending', 'accepted'],
  previousDeal: ['', 'yes'],
  fitVerified: ['', 'yes'],
  rate: ['', 'yes', 'no'], start: ['', 'yes', 'no'], location: ['', 'yes', 'no'], flow: ['', 'yes', 'no'],
  interviewResult: ['', 'passed', 'failed'],
};
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const integer = (value, max) => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= max);

export function normalizeReadinessFacts(body, today, meetingHeld) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const facts = {};
  for (const [key, values] of Object.entries(FACT_OPTIONS)) {
    const value = body[key] ?? '';
    if (!values.includes(value)) return null;
    facts[key] = value;
  }
  for (const key of ['hiringCount', 'interviewCount', 'otherInterviews']) {
    const value = body[key] ?? null;
    if (!integer(value, 999)) return null;
    facts[key] = value;
  }
  for (const key of ['confirmedOn', 'targetStart', 'meetingDue']) {
    const value = body[key] || '';
    if (value && !date(value)) return null;
    facts[key] = value;
  }
  if (facts.confirmedOn > today || (facts.interviewResult && !meetingHeld)) return null;
  const note = body.note ?? '';
  if (typeof note !== 'string' || note.trim().length > 400) return null;
  if ((facts.previousDeal || facts.fitVerified) && !note.trim()) return null;
  return { ...facts, note: note.trim() };
}

const sectionHeading = /^(?:【\s*|[■◆●◇◎□#]+\s*)?((?:必須|尚可|歓迎|優遇|任意|募集|業務|備考|条件|勤務地|期間|単価|人数|面談|商流|精算|時間|場所|勤務|案件|スキル|概要|勤務形態)[^:：】]{0,18})(?:】\s*[:：]?|[:：]|$)\s*(.*)$/u;
export function requiredSkillLines(detail) {
  if (typeof detail !== 'string') return [];
  const lines = [];
  let inRequired = false;
  for (const raw of detail.slice(0, 18000).normalize('NFKC').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = line.match(sectionHeading);
    if (heading) {
      inRequired = /^必須/.test(heading[1]);
      if (inRequired && heading[2]) lines.push(heading[2]);
    } else if (inRequired && /^[-・･*◦]|^\d+[.)]/.test(line)) lines.push(line.replace(/^(?:[-・･*◦]|\d+[.)])\s*/, ''));
    else if (line) inRequired = false;
  }
  const personal = /年齢|国籍|性別|健康|家族|生年月日|\d+歳|外国籍|日本国籍/u;
  return [...new Set(lines.filter(line => !personal.test(line)).map(line => redact(line, 220)).filter(Boolean))].slice(0, 12);
}
const alias = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const skillTerms = values => [...new Set((values || []).filter(v => typeof v === 'string')
  .map(v => v.normalize('NFKC').trim()).filter(v => /^[\p{L}\p{N} .#_+/-]{1,40}$/u.test(v))
  .filter(v => redact(v, 40)))].slice(0, 24);
const mentions = (line, skill) => new RegExp('(^|[^a-z0-9+#.])' + escaped(alias(skill)) + '($|[^a-z0-9+#.]|[.](?![a-z0-9]))', 'i').test(alias(line));

export function evidenceFor(job, candidate, storedAi) {
  const jobSkills = skillTerms(job?.skills);
  const skills = skillTerms(candidate?.skills);
  const required = requiredSkillLines(job?.detail);
  const matched = jobSkills.filter(skill => skills.some(t => alias(t) === alias(skill)));
  const missing = jobSkills.filter(skill => !matched.includes(skill));
  const checks = required.map(requirement => ({
    requirement, matches: skills.filter(skill => mentions(requirement, skill)).slice(0, 6),
  }));
  const absent = checks.filter(check => !check.matches.length);
  const ai = storedAi?.result_json;
  const lines = value => (Array.isArray(value) ? value : []).map(v => redact(v, 220)).filter(Boolean).slice(0, 3);
  const evaluated = ai && (Array.isArray(ai.matched) || Array.isArray(ai.questions));
  const minYears = typeof job?.required_experience_years === 'string' && /^\d+(?:\.\d+)?(?:年(?:以上)?)?$/.test(job.required_experience_years.trim())
    ? Number(job.required_experience_years.match(/\d+(?:\.\d+)?/)[0]) : null;
  const experience = redact(candidate?.exp, 90);
  // A requires an ENGER evaluation with evidence, current inputs and no flagged gap.
  const grade = !job || !candidate ? null
    : evaluated && Number(storedAi.score) >= 85 && lines(ai.matched).length && !lines(ai.mismatch).length
      && !lines(ai.concerns).length && !lines(ai.critical_mismatches).length && checks.length && !absent.length ? 'A'
      : evaluated && (lines(ai.critical_mismatches).length || (storedAi.score != null && Number(storedAi.score) < 50)) ? 'C'
      : checks.length && absent.length === checks.length && skills.length ? 'C'
      : matched.length || checks.some(check => check.matches.length) || evaluated ? 'B' : null;
  return {
    grade, checks, matched, missing, experience, minYears, skills, jobSkills,
    ai: evaluated ? { at: storedAi.analyzed_at, strengths: lines(ai.matched), concerns: [...lines(ai.critical_mismatches), ...lines(ai.mismatch), ...lines(ai.concerns)].slice(0, 3), questions: lines(ai.questions) } : null,
  };
}

const values = { A: 1, B: 0.65, C: 0.25 };
const dimension = (grade, why) => ({ grade, why });
export function assessReadiness({ facts, source, fit, history, conditions, today, inactive }) {
  const f = facts || {};
  const stale = f.confirmedOn && Date.parse(today) - Date.parse(f.confirmedOn) > 14 * 86400000;
  const firmNo = f.hiring === 'stopped' || f.budget === 'no' || f.hiringCount === 0 || source.job_action_type === 'pass';
  const personNo = f.intent === 'no' || f.offers === 'accepted' || source.cand_action_type === 'pass';
  const acted = f.hiring === 'confirmed' && f.budget === 'yes';
  const relationship = firmNo ? dimension('C', '募集・予算・企業の回答を確認')
    : f.contact === 'direct' && acted && (history?.meetings || f.previousDeal === 'yes') ? dimension('A', '採用担当と直接連絡でき、募集・予算と面談実績を確認')
    : ['direct', 'staff'].includes(f.contact) ? dimension('B', acted ? '担当者と会話でき、募集・予算を確認' : '担当者と会話可能。募集・予算は確認が必要')
    : f.contact === 'mail' ? dimension('C', 'メール中心・窓口や決定権を要確認')
    : dimension(null, '採用担当との関係・募集の実態を未確認');
  const grip = personNo ? dimension('C', '辞退・他社決定・人材側の見送りを確認')
    : stale ? dimension(null, '意思確認から14日を超えています')
    : f.candidateContact === 'direct' && f.intent === 'yes' && f.confirmedOn && f.dates === 'yes' && f.offers === 'none'
      ? dimension('A', '本人の応募意思・面談候補日と他社内定なしを確認')
    : ['direct', 'affiliate'].includes(f.candidateContact) && f.intent === 'yes' && f.confirmedOn
      ? dimension('B', '応募意思を確認。面談候補日・他社選考の状況を確認')
    : f.candidateContact === 'sheet' ? dimension('C', 'スキルシートのみ。本人意思を未確認')
    : dimension(null, '本人の応募意思・最終確認日を確認');
  const gaps = Object.keys(TERM_LABELS).filter(key => f[key] === 'no').map(key => TERM_LABELS[key]);
  const missingTerms = Object.keys(TERM_LABELS).filter(key => f[key] !== 'yes').map(key => TERM_LABELS[key]);
  const terms = gaps.length ? dimension('C', gaps.join('・') + 'に条件差あり')
    : !missingTerms.length ? dimension('A', '単価・開始日・勤務地・商流を確認')
    : missingTerms.length < 4 ? dimension('B', missingTerms.join('・') + 'を確認')
    : dimension(null, '単価・開始日・勤務地・商流を未確認');
  const fitConfirmed = f.fitVerified === 'yes' && fit.grade !== 'C' && !conditions?.unlinked;
  const dimensions = { relationship, grip, fit: fitConfirmed
    ? dimension('A', '必須スキルと類似案件での実績を確認')
    : dimension(fit.grade, fit.ai ? 'ENGER AIの根拠を確認' : '案件の必須記載と登録スキルを比較'), terms };
  const complete = Object.keys(WEIGHTS).every(key => dimensions[key].grade);
  const score = complete ? Math.round(Object.keys(WEIGHTS).reduce((sum, key) => sum + WEIGHTS[key] * values[dimensions[key].grade], 0)) : null;
  const blocker = Object.values(dimensions).some(item => item.grade === 'C') || Boolean(conditions?.closed || conditions?.sourceClosed);
  const grade = inactive ? null : blocker ? 'C' : !complete || conditions?.unlinked ? null
    : score >= 85 && acted && grip.grade === 'A' && terms.grade === 'A' && dimensions.fit.grade === 'A' ? 'A' : score >= 65 ? 'B' : 'C';
  const next = inactive ? '対応履歴を確認'
    : conditions?.sourceClosed ? 'ENGERの終了理由とSalesの対応履歴を照合'
    : conditions?.closed ? '募集・稼働状況の再開可否を確認'
    : firmNo ? '企業に募集継続・採用予算を確認'
    : conditions?.unlinked ? 'ENGERで案件・人材の紐づけを確認'
    : personNo ? 'ENGERと本人の最新状況を確認し、別候補を検討'
    : !acted || !f.contact || f.contact === 'mail' ? '企業に採用担当・募集人数・予算・面談時期を確認'
    : !grip.grade || grip.grade === 'C' ? '本人の応募意思、面談候補日、他社選考を確認'
    : gaps.length ? gaps.join('・') + 'の条件を双方と調整'
    : !fitConfirmed && (!fit.grade || fit.grade === 'C' || fit.checks.some(c => !c.matches.length)) ? '必須条件に対する実務経験・役割・成果を確認'
    : f.dates !== 'yes' || f.offers !== 'none' ? '本人の面談候補日と他社選考・内定状況を確認'
    : missingTerms.length ? missingTerms.join('・') + 'を双方と確認'
    : f.interviewResult === 'passed' ? '企業と本人に最終条件・開始日を確認'
    : f.interviewResult === 'failed' ? '企業に見送り理由を確認し、ENGERと共有'
    : conditions?.meetingHeld ? '企業に面談結果と判断理由を確認'
    : conditions?.meetingBooked ? '面談前に実務経験の根拠と当日の確認事項を整理'
    : '企業に面談候補日を2つ提示';
  return { version: POLICY_VERSION, grade, score, dimensions, next, stale: Boolean(stale) };
}
