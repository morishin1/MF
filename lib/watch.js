// 社員ごとの「いまどうなっているか」と、「要確認」の判定。
//
// ■ 見る単位を、端末から人に変えた
//
//   これまでは端末が1行だった。同じ人のPCとブラウザが別々に並び、
//   管理者は「この行とこの行が同じ人」を頭の中でつないでいた。
//
//   知りたいのは端末の調子ではなく、**その人がちゃんと働けているか**。
//   だから1行＝1人にする。
//
// ■ 正常な人は、細かく見ない
//
//   ○ が並んでいる人の中身を毎日見に行く運用は続かないし、
//   続けるべきでもない。
//   問題があるときだけ △ を出して、そこだけ開く。
//
// ■ しきい値は、ここ1か所
//
//   「何分から長時間なのか」を画面ごとに書くと、一覧と詳細で違う、が起きる。
//   そして **社員には出さない**（避け方を配ることになる）。
//   docs/device-spec-internal.md と同じ扱い。

/** 社内の管理基準。社員向けの画面には出さない */
export const LIMITS = {
  // グループウェアからの合図が、これだけ途切れたら「離席」
  idleMin: 15,
  // 勤務時間中に、合図も WEB利用も無い時間がこれを超えたら要確認
  noActivityMin: 90,
  // 勤務時間中の業務外カテゴリが、1日でこれを超えたら要確認
  offTopicMin: 90,
  // 打刻の労働時間と、実際に動いていた時間の差がこれを超えたら要確認
  gapMin: 120,
  // 最後に何か届いてから、これを超えたら「未通信」
  silentHours: 24,
  // 本人がグループウェアを使っているのに、拡張から届かない状態が「続いた」時間。
  // 拡張は1分ごとに送る。それでもここまで待つのは、
  // 立ち上げ直し・自動更新・一時的な停止を × にしないため
  extSilentMin: 60,
};

/** 業務外とみなすカテゴリ。悪いと決めつけるためではなく、続いたら見るため */
export const OFF_TOPIC = ["sns", "video", "shopping"];

// ---- 勤務状況 -------------------------------------------------------------------

/**
 * いま何をしているか。
 *
 *   working  … 動いている（グループウェアからの合図が来ている）
 *   away     … 打刻はあるが、しばらく合図が無い
 *   off      … 打刻が無い（勤務時間外・休み）
 *   unknown  … 何も分からない
 *
 * 「働いていない」とは言わない。合図が来ているかどうかしか分からない
 */
export function workState({ lastSeenAt, clockIn, clockOut, now = Date.now() }) {
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : 0;
  const mins = seen ? (now - seen) / 60000 : Infinity;
  const onDuty = Boolean(clockIn) && !clockOut;

  if (!onDuty) {
    return clockIn && clockOut
      ? { key: "done", label: "退勤済み" }
      : { key: "off", label: "勤務時間外" };
  }
  if (mins <= LIMITS.idleMin) return { key: "working", label: "操作中" };
  return { key: "away", label: "離席", mins: Math.round(mins) };
}

/**
 * ブラウザ拡張がつながっているか。
 *
 * ■ 「つないだことがある」と「いまつながっている」は別
 *
 *   台帳に印を付けたきりにすると、拡張を外されても ○ のまま残る。
 *   登録を外せるのは管理者だけ、と決めていても、
 *   本人がブラウザから拡張を消すことはできてしまう。
 *   止められないなら、せめて **黙って消えないようにする**。
 *
 *   見分け方はこう。
 *     グループウェアの合図は来ている（＝そのブラウザを使っている）
 *     なのに拡張からは届かない（＝拡張が無い・止まっている）
 *
 *   ブラウザを閉じているだけなら、合図も来ない。だから区別できる。
 */
export function extState(devices, now = Date.now()) {
  const mine = (devices || []).filter((d) => d.source === "browser");
  if (!mine.length) return { key: "none", mark: "—", label: "端末なし" };

  const live = mine.filter((d) => d.extLinked && !extGone(d, now));
  if (live.length) return { key: "ok", mark: "○", label: "連携済み" };

  // 一度はつないだのに、届かない状態が続いている。
  //
  // ここで「削除された」とは書かない。分かっているのは
  // 「届いていない」ことだけで、止めたのか消したのかまでは分からない
  if (mine.some((d) => d.registeredAt)) {
    return { key: "removed", mark: "×", label: "連携異常" };
  }
  return { key: "off", mark: "△", label: "未設定" };
}

/**
 * その端末で、拡張が外れた（止まった）と見てよいか。
 *
 * ■ その瞬間だけを見て決めない
 *
 *   「合図は来ているのに拡張からは届かない」は、
 *   外していなくても普通に起きる。
 *
 *     ・ブラウザを立ち上げ直した直後（拡張がまだ1回も送っていない）
 *     ・拡張の自動更新中
 *     ・拡張が落ちて、すぐ上がった
 *
 *   その一瞬で × にすると、毎日どこかの誰かが赤くなる。
 *   赤が日常になると、本当に外した人が埋もれる。
 *
 * ■ 「いつから続いているか」で決める
 *
 *   届かなくなった時刻は、合図が来るたびに台帳へ置いてある
 *   （ext_missing_since。api/devices/me.js の markExtGap）。
 *   拡張が1回でも送ってくれば消える。
 *   立ち上げ直しや更新なら、次の合図までに消えるので、ここへは来ない。
 *
 *   ここで見るのは、それが一定時間続いたかどうかだけ。
 *
 * ■ 数えるのは「合図が来ていたあいだ」であって、いま何時かではない
 *
 *   条件は「グループウェアの操作があるのに拡張通信が無い状態が続いた」。
 *   だから、届かなくなった時刻と **最後に合図が来た時刻** の差で見る。
 *
 *   いまからの経過で見ると、2つ壊れる。
 *     ・帰ったあと時間が経つだけで × になる（操作は続いていない）
 *     ・翌朝その × が消える（管理者が見る前に無かったことになる）
 *
 *   合図が途切れていたぶんは、ext_missing_since を置き直すときに
 *   捨ててある（api/devices/me.js の markExtGap）。
 */
export function extGone(d, now = Date.now()) {
  if (!d?.registeredAt) return false;             // 一度もつないでいない
  if (!d.extMissingSince) return false;           // 続いていない（届いている）
  const since = Date.parse(d.extMissingSince);
  const beat = d.lastSeenAt ? Date.parse(d.lastSeenAt) : 0;
  if (!since || !beat) return false;
  return (beat - since) > LIMITS.extSilentMin * 60000;
}

// ---- 要確認 ---------------------------------------------------------------------

/**
 * その人で、人が見たほうがよいこと。
 *
 * 返すのは「何が」と「次にどうするか」。
 * 判定の数字（何分から、何%から）は返さない。
 * 画面から社員に見えることがあるし、避け方を配ることになる。
 *
 * @param {object} p
 *   name        氏名
 *   devices     その人の端末（source / lastSeenAt / extLinked / ownership / confirmed）
 *   work        workState の戻り
 *   webMin      今日の WEB利用（分）
 *   offTopicMin 勤務時間中の業務外カテゴリ（分）
 *   activeMin   実際に動いていた時間（分）
 *   clockMin    打刻からの労働時間（分）
 *   quietMin    勤務時間中に、何も届いていない時間（分）
 */
export function issuesOf(p) {
  const out = [];
  const devices = p.devices || [];

  // 1) 勤務時間中に、長く何も届いていない
  if (p.work?.key === "away" && (p.quietMin ?? 0) >= LIMITS.noActivityMin) {
    out.push({
      key: "no_activity", sev: "warn",
      what: "勤務中ですが、しばらく操作が確認できていません",
      next: "本人に声をかけて、体調や作業の状況を確かめてください",
    });
  }

  // 2) 勤務時間中の業務外カテゴリが続いている
  if ((p.offTopicMin ?? 0) >= LIMITS.offTopicMin) {
    out.push({
      key: "off_topic", sev: "warn",
      what: "勤務時間中に、業務と関係の薄いサイトの利用が続いています",
      next: "WEB利用を開いて、内容を見てから本人と話してください",
    });
  }

  // 3) ブラウザ拡張が未接続
  //
  // ここが切れていると、WEB利用が1件も取れない。
  // 「利用が無い」のか「取れていない」のかが見分けられなくなる
  const ext = extState(devices);
  if (ext.key === "off") {
    out.push({
      key: "ext_off", sev: "warn",
      what: "ブラウザ拡張がつながっていません（WEB利用が取れません）",
      next: "本人にマイページを開いて、登録を押してもらってください",
    });
  }

  // 3-b) 一度つないだのに、届かない状態が続いている
  //
  //   登録を台帳から外せるのは管理者だけにしてある。
  //   ただしブラウザから拡張を消すことまでは止められない。
  //   止められないなら、せめて黙って消えないようにする。
  //   ここは「未設定」より重く出す。
  //
  //   ただし「消された」とは書かない。分かっているのは届いていないことだけで、
  //   止めたのか、消したのか、壊れたのかまでは分からない。
  //   決めつけた文面を管理者に読ませると、本人への話がそこから始まってしまう
  if (ext.key === "removed") {
    out.push({
      key: "ext_removed", sev: "critical",
      what: "グループウェアへのアクセスはありますが、"
          + "登録済みのブラウザ拡張から通信がありません。"
          + "拡張が停止・削除されている可能性があります。",
      next: "本人に、拡張が入っているか確認してください。"
          + "入れ直しが必要なら、管理者が再登録してください",
    });
  }

  // 4) 未登録のパソコンから、グループウェアに入っている
  const unknown = devices.filter((d) =>
    d.source === "browser" && !d.confirmed && d.ownership !== "company");
  if (unknown.length) {
    out.push({
      key: "unknown_pc", sev: "critical",
      what: `登録されていないパソコンから社内システムを開いています（${unknown.length}台）`,
      next: "会社貸与か私物かを確かめて、私物なら業務利用をやめてもらってください",
    });
  }

  // 5) 打刻と、実際に動いていた時間が大きく違う
  //
  //    どちらが正しいとは言わない。
  //    打刻の押し忘れも、長い会議も、外出もある。見て確かめるためのもの
  if (p.clockMin != null && p.activeMin != null) {
    const gap = Math.abs(p.clockMin - p.activeMin);
    if (p.clockMin > 0 && gap >= LIMITS.gapMin) {
      out.push({
        key: "gap", sev: "warn",
        what: p.clockMin > p.activeMin
          ? "打刻より、実際に動いていた時間がかなり短くなっています"
          : "打刻より、実際に動いていた時間がかなり長くなっています",
        next: "打刻の押し忘れ・直行直帰・長時間の会議など、事情を確かめてください",
      });
    }
  }

  // 6) しばらく何も届いていない
  const last = Math.max(0, ...devices.map((d) => (d.lastSeenAt ? Date.parse(d.lastSeenAt) : 0)));
  if (devices.length && last && (Date.now() - last) > LIMITS.silentHours * 3600000) {
    out.push({
      key: "silent", sev: "silent",
      what: "しばらく、この方の端末から何も届いていません",
      next: "休暇中でなければ、端末が使えているか確かめてください",
    });
  }

  return out;
}

/** ○ / △ / × の1文字。一覧はこれだけで読めるようにする */
export function mark(issues, work) {
  const list = issues || [];
  if (list.some((i) => i.sev === "critical")) return { k: "bad", m: "×", t: "要確認" };
  if (list.some((i) => i.sev === "silent")) return { k: "silent", m: "×", t: "未通信" };
  if (list.length) return { k: "warn", m: "△", t: "要確認" };
  if (work?.key === "working") return { k: "ok", m: "○", t: "正常" };
  return { k: "ok", m: "○", t: "正常" };
}

/** 分を「6:30」にする */
export const clock = (min) => {
  const m = Math.max(0, Math.round(Number(min) || 0));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};
