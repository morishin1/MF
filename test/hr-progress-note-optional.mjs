// HRの状態変更では、確認方法・確認日を残しつつ自由記述を強制しない。
// 採否の決定を伴う「moveStep」の理由必須とは区別する。
import assert from 'node:assert/strict';
import { validateProgressInput, progressDetail, progressNotices, PROGRESS_EVENT } from '../lib/hr-progress.js';

const today='2026-11-14';
const base={method:'phone',confirmedOn:today};
assert.deepEqual(validateProgressInput(base,today),{note:''},'自由記述がなくても変更できる');
assert.deepEqual(validateProgressInput({...base,note:'   '},today),{note:''},'空白メモも許容する');
assert.deepEqual(validateProgressInput({...base,note:'電話で確認'},today),{note:'電話で確認'},'任意メモは記録できる');
assert.equal(validateProgressInput({...base,note:'あ'.repeat(501)},today).error,'note_too_long','長すぎるメモは防ぐ');
assert.equal(validateProgressInput({...base,confirmedOn:'2026-11-15'},today).error,'invalid_date','未来の日付は拒否');
assert.equal(validateProgressInput({...base,method:'unknown'},today).error,'invalid_method','不正な確認方法は拒否');

const event={event_key:PROGRESS_EVENT,detail:JSON.stringify({
  version:1,from:'offer',phase:'trial',method:'phone',confirmedOn:today,note:'',
})};
const line=progressDetail(event);
assert.match(line,/合格通知.*トライアル/);
assert.match(line,/確認方法：電話/);
assert.match(line,/確認日：2026-11-14/);
assert.ok(!line.includes('確認内容：'),'空メモを履歴に表示しない');
const withNote=progressDetail({...event,detail:JSON.stringify({
  version:1,from:'offer',phase:'trial',method:'phone',confirmedOn:today,note:'電話で確認',
})});
assert.match(withNote,/確認内容：電話で確認/);
assert.match(progressNotices('trial').notes.join(''),/メールは送信されません/);
console.log('PASS HR progress update without required free-text note; method, date and record retained');
