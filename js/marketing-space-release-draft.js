/* =============================================================
   EIGHT SPACE — リリース草案の組み立て

   入力された項目を、PR TIMES にそのまま貼れる並びに流し込む。
   文章は書かない。並べ替えと、決まった見出しの当てはめだけ。

   ■ AI は呼ばない
     ここから OpenAI や Claude の API を叩かない。鍵も持たない。
     日本語を整えるのは、できあがった全文をコピーして
     手元の AI に渡す運用にする。そのためのプロンプトも
     この中で組み立てる（buildPrompt）。

   ■ 空の項目は、見出しごと出さない
     「■背景」だけあって中身が無いと、埋め忘れなのか
     もともと無いのか、受け取った側に判断がつかない。

   ブラウザからも Node からも読めるようにしてある（テスト用）。
   ============================================================= */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpaceRelease = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 発表種類。PR TIMES のカテゴリの選び方に寄せてある。
     value は DB の check 制約と揃える */
  /* KINDS の見かた
       block … 草案の中の見出し（■ 開催概要 など）
       feat  … 特徴の見出し
       form  … 入力画面に出す節の名前と、その中に出す欄
               全部の種別に同じ欄を出すと、関係のない欄まで目で追うことになる。
               種別を選んだ時点で、要るものだけ出す。
       date / end / time / venue / fee / url / target / partner
               … その欄を出すかどうか。文字列のときはラベルになる */
  var KINDS = [
    { value: 'service',     label: '新サービス・新機能',    block: 'サービス概要', feat: 'サービスの特徴',
      form: { title: '提供内容', date: '提供開始日', url: 'サービスのURL',
              fee: '料金', target: '対象となる方' } },
    { value: 'product',     label: '新商品',                block: '商品概要',     feat: '商品の特徴',
      form: { title: '発売情報', date: '発売日', url: '商品のURL',
              fee: '価格', target: '対象となる方' } },
    { value: 'event',       label: 'イベント・セミナー',    block: '開催概要',     feat: 'イベントの見どころ',
      form: { title: '開催情報', date: '開催日', time: true, venue: true,
              fee: '参加費', url: '申込・詳細のURL', target: '対象となる方' } },
    { value: 'campaign',    label: 'キャンペーン',          block: 'キャンペーン概要', feat: 'キャンペーンの特徴',
      form: { title: '実施情報', date: '開始日', end: '終了日',
              url: 'キャンペーンのURL', target: '対象となる方' } },
    { value: 'partnership', label: 'コラボ・提携',          block: '提携の概要',   feat: '提携で実現すること',
      form: { title: '提携の内容', date: '開始日', url: '詳細のURL', partner: '提携先' } },
    { value: 'research',    label: '調査・レポート',        block: '調査概要',     feat: '調査結果のポイント',
      form: { title: '公開情報', date: '公開日', url: 'レポートのURL', target: '調査の対象' } },
    { value: 'corporate',   label: '会社情報（人事・資金調達など）', block: '概要', feat: 'ポイント',
      form: { title: '実施情報', date: '実施日', url: '詳細のURL' } },
    { value: 'other',       label: 'その他',                block: '概要',         feat: 'ポイント',
      form: { title: '日時・場所・料金', date: '日付', time: true, venue: true,
              fee: '料金', url: 'URL', target: '対象となる方' } }
  ];

  /** 入力画面に出す欄の決まり。知らない種別でも必ず何か返す */
  function formOf(kind) {
    return kindOf(kind).form || KINDS[KINDS.length - 1].form;
  }

  /** その欄を出すか */
  function shows(kind, field) { return !!formOf(kind)[field]; }

  /** その欄のラベル。true しか入っていないときは既定の名前を使う */
  var DEFAULT_LABELS = {
    date: '日付', end: '終了日', fee: '料金', url: 'URL',
    target: '対象となる方', partner: '提携先'
  };
  function labelOf(kind, field) {
    var v = formOf(kind)[field];
    return (typeof v === 'string' && v) ? v : (DEFAULT_LABELS[field] || '');
  }

  /* ステータス。DB の check 制約と揃える */
  var STATUSES = [
    { value: 'draft',     label: '下書き',   hint: '自分で書いている途中' },
    { value: 'review',    label: '確認待ち', hint: 'エイトスペース運営事務局が内容を見ています' },
    { value: 'revising',  label: '修正中',   hint: 'エイトスペース運営事務局から修正の依頼があります' },
    { value: 'approved',  label: '掲載OK',   hint: '確認が済みました。掲載を待っています' },
    { value: 'published', label: '公開済み', hint: 'PR TIMES に掲載しました' }
  ];

  function kindOf(value) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].value === value) return KINDS[i];
    return KINDS[KINDS.length - 1];
  }

  function statusOf(value) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].value === value) return STATUSES[i];
    return STATUSES[0];
  }

  var s = function (v) { return String(v == null ? '' : v).trim(); };
  var has = function (v) { return s(v) !== ''; };

  /* =============================================================
     選ぶだけで書けるようにするための決まり

     日時・場所・料金は、草案には1行の文として載る。
     打つ手間をなくすため、画面では日付・時刻・会場・金額を選んでもらい、
     ここで文に組み立てる。組み立てた文は DB の event_date / place / price
     にも入れるので、これまでの草案や、管理側の見え方は変わらない。
     ============================================================= */

  /* 会場。住所は選んだ時点で自動で入る。
     note は、どちらを選べばよいか分かるようにするための一行。
     選ぶ欄の下と、選んだあとの説明に出す */
  var VENUES = [
    { value: 'eight-space', label: 'EIGHT SPACE（原宿）',
      note: 'セミナー・研修・会議・展示・撮影などにおすすめ',
      about: 'セミナー、研修、会議、展示、撮影などに適したスペースです。',
      image: '../img/event-space.webp',
      address: '〒150-0001 東京都渋谷区神宮前6-33-14（明治神宮前駅 徒歩1分）' },
    { value: 'eight-cafe',  label: 'EIGHT CAFE（原宿）',
      note: '飲食を伴うイベント・交流会・懇親会などにおすすめ',
      about: '飲食を伴うイベント、交流会、懇親会などに適したスペースです。',
      image: '../img/hero-cafe.webp',
      address: '〒150-0001 東京都渋谷区神宮前6-33-14（明治神宮前駅 徒歩1分）' },
    { value: 'online',      label: 'オンライン', address: 'オンライン開催',
      note: 'オンラインのみで開催する場合',
      about: 'オンラインでの開催です。' },
    { value: 'other',       label: 'その他',     address: '',
      note: '上記以外の会場', about: '' }
  ];

  function venueOf(v) {
    for (var i = 0; i < VENUES.length; i++) if (VENUES[i].value === v) return VENUES[i];
    return null;
  }

  /* 参加費の種類 */
  var FEES = [
    { value: 'free',   label: '無料',   text: '無料' },
    { value: 'paid',   label: '有料',   text: '' },
    { value: 'invite', label: '招待制', text: '招待制' }
  ];

  /* 30分刻みの時刻。00:00 から 23:30 まで */
  function timeOptions() {
    var out = [];
    for (var h = 0; h < 24; h++) {
      for (var m = 0; m < 60; m += 30) {
        out.push((h < 10 ? '0' : '') + h + ':' + (m ? '30' : '00'));
      }
    }
    return out;
  }

  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  /** '2026-10-18' → '2026年10月18日（日）'。日本時間で曜日を出す */
  function jpDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s(ymd));
    if (!m) return '';
    // 曜日は UTC で組んで UTC で読む。端末の時計がどこでもずれない
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return +m[1] + '年' + (+m[2]) + '月' + (+m[3]) + '日（' + WEEK[d.getUTCDay()] + '）';
  }

  /** 選んだ日付と時間から、草案に載る「日時」の1行を作る */
  function composeEventDate(d) {
    d = d || {};
    var day = jpDate(d.event_on);
    if (!day) return s(d.event_date);           // 日付未定など、文で書いてあるとき

    // 「2026年10月18日（日）14:00〜17:00」。閉じ括弧で区切れるので空白は入れない
    // 期間があるとき（キャンペーンなど）は「〜」でつなぐ。時刻は付けない
    var last = jpDate(d.event_end_on);
    if (last && last !== day) return day + '〜' + last;

    if (d.event_allday) return day + '終日';
    if (d.event_time_tbd) return day + '時間未定';

    var a = s(d.event_start), b = s(d.event_end);
    if (a && b) return day + a + '〜' + b;
    if (a) return day + a + '〜';
    return day;
  }

  /** 選んだ会場から、草案に載る「場所」の1行を作る */
  function composePlace(d) {
    d = d || {};
    var v = venueOf(d.venue);
    if (!v) return s(d.place);                  // 選んでいない、または古い草案

    var name = v.value === 'other' ? s(d.venue_name) : v.label;
    var addr = s(d.venue_address) || v.address;
    if (v.value === 'online') return name || v.label;
    if (!name) return addr;
    return addr ? name + '（' + addr + '）' : name;
  }

  /** 選んだ参加費から、草案に載る「料金」の1行を作る */
  function composePrice(d) {
    d = d || {};
    if (!has(d.fee_type)) return s(d.price);    // 選んでいない、または古い草案
    if (d.fee_type === 'free')   return '無料';
    if (d.fee_type === 'invite') return '招待制';

    var n = Number(d.fee_amount);
    if (!isFinite(n) || n <= 0) return s(d.price);
    var tax = d.fee_tax === 'excl' ? '（税別）' : d.fee_tax === 'incl' ? '（税込）' : '';
    return yen(n) + '円' + tax;
  }

  function yen(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * 選んだ内容から、草案に載る3行を作る。
   * 選んでいない項目は、これまでどおり自由入力の文をそのまま使う。
   */
  function composed(d) {
    d = d || {};
    return {
      event_date: composeEventDate(d),
      place: composePlace(d),
      price: composePrice(d)
    };
  }

  /* タイトルの例。何を書けばよいか分からないと、ここで手が止まる。
     種類ごとに、形の違う3案を出す */
  var TITLE_EXAMPLES = {
    service: [
      '株式会社〇〇、中小企業向けの請求書作成サービス「〇〇」を10月1日に提供開始',
      '〇〇、店舗の在庫管理を自動化する「〇〇」をリリース　初期費用0円で導入可能に',
      '人手不足の現場へ。〇〇が新サービス「〇〇」の提供を開始'
    ],
    product: [
      '株式会社〇〇、国産素材のみを使った「〇〇」を10月1日より全国で発売',
      '〇〇、片手で開けられる「〇〇」を新発売　従来品より30%軽量化',
      '職人の技術を日常へ。〇〇が新商品「〇〇」を発表'
    ],
    event: [
      '株式会社〇〇、10月18日に「〇〇」を原宿で開催　参加無料・先着40名',
      '〇〇主催のセミナー「〇〇」を10月18日に開催　オンライン同時配信あり',
      '実際に触って選ぶ1日。「〇〇」を10月18日に原宿で開催'
    ],
    campaign: [
      '株式会社〇〇、「〇〇キャンペーン」を10月1日より開始　期間中は初月無料',
      '〇〇、開業3周年を記念して「〇〇」を実施　先着100名に〇〇をプレゼント'
    ],
    partnership: [
      '株式会社〇〇と株式会社〇〇、地域の〇〇を支える業務提携を締結',
      '〇〇、〇〇と協業開始　両社の〇〇を組み合わせた〇〇の提供へ'
    ],
    research: [
      '株式会社〇〇、「〇〇に関する意識調査」を発表　〇〇と回答した人が62%',
      '〇〇が中小企業300社に聞いた〇〇の実態調査を公開'
    ],
    corporate: [
      '株式会社〇〇、〇〇を取締役に選任　〇〇体制を強化',
      '〇〇、シリーズAで〇〇億円の資金調達を実施'
    ],
    other: [
      '株式会社〇〇、〇〇を10月1日より開始',
      '〇〇、〇〇に関する取り組みを発表'
    ]
  };

  function titleExamples(kind) {
    return TITLE_EXAMPLES[kind] || TITLE_EXAMPLES.other;
  }

  /**
   * 会員の登録情報から、草案の初期値を作る。
   * 毎回同じことを打たせないための下敷き。あとから直せる。
   */
  function fromProfile(me) {
    me = me || {};
    var addr = [s(me.bill_zip) ? '〒' + s(me.bill_zip) : '', s(me.bill_address)]
      .filter(function (x) { return x; }).join(' ');
    return {
      company:       s(me.bill_company) || s(me.org),
      location:      addr,
      contact_dept:  s(me.bill_dept),
      contact_name:  s(me.bill_person) || s(me.name),
      contact_tel:   s(me.phone),
      contact_email: s(me.email)
    };
  }

  /* 「項目：値」の並び。値のある行だけ返す */
  function pairs(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (has(list[i][1])) out.push(list[i][0] + '：' + s(list[i][1]));
    }
    return out;
  }

  /**
   * 入力から PR TIMES 用の草案を組み立てる。
   * @param {object} d 画面の入力（DB の列名と同じ）
   * @returns {string} 全文
   */
  function buildDraft(d) {
    d = d || {};
    var k = kindOf(d.kind);
    var out = [];

    /* ---- 見出し ---- */
    if (has(d.title)) out.push(s(d.title));
    if (has(d.subtitle)) out.push(s(d.subtitle));

    /* ---- リード ----
       会社名と所在地・代表者を頭に置くのが PR TIMES の通例。
       入力があるぶんだけ括弧に入れる */
    var who = [];
    if (has(d.location)) who.push('本社：' + s(d.location));
    if (has(d.representative)) who.push('代表者：' + s(d.representative));

    var lead = '';
    if (has(d.company)) {
      lead = s(d.company) + (who.length ? '（' + who.join('、') + '）' : '');
      lead += 'は、';
    }
    if (has(d.summary)) {
      var body = s(d.summary);
      // 「〜は、」に続けるので、本文が会社名から始まっていたら重ねない
      if (lead && body.indexOf(s(d.company)) === 0) lead = '';
      lead += body;
    }
    if (has(lead)) out.push('', lead);

    /* ---- 背景 ---- */
    if (has(d.background)) out.push('', '■ 背景', s(d.background));

    /* ---- 特徴 ---- */
    var feats = normalizeFeatures(d.features);
    if (feats.length) {
      out.push('', '■ ' + k.feat);
      for (var i = 0; i < feats.length; i++) {
        var f = feats[i];
        out.push('');
        out.push((i + 1) + '. ' + f.title);
        if (has(f.body)) out.push(f.body);
      }
    }

    /* ---- 概要（日時・場所・料金・URL） ----
       選んでもらった内容を1行にまとめる。選んでいない項目は、
       これまでどおり自由入力の文がそのまま出る */
    var c = composed(d);
    var f = formOf(d.kind);
    // 見出しの名前も種別に合わせる。イベントなら「開催日」、
    // サービスなら「提供開始日」。同じ欄でも呼び方が違う
    var overview = pairs([
      [f.end ? '実施期間' : labelOf(d.kind, 'date'), c.event_date],
      ['場所', f.venue ? c.place : ''],
      [labelOf(d.kind, 'fee'), f.fee ? c.price : ''],
      [labelOf(d.kind, 'partner'), f.partner ? d.partner : ''],
      [labelOf(d.kind, 'target'), f.target ? d.target : ''],
      [labelOf(d.kind, 'url'), d.url]
    ]);
    if (overview.length) out.push('', '■ ' + k.block, overview.join('\n'));

    /* ---- 今後の展開 ---- */
    if (has(d.future)) out.push('', '■ 今後の展開', s(d.future));

    /* ---- 画像の指示 ----
       PR TIMES には画像を別途アップロードする。どこに何を入れるかを
       本文に残しておかないと、貼るときに順番が分からなくなる */
    var imgs = normalizeImages(d.images);
    if (imgs.length) {
      var lines = [];
      for (var j = 0; j < imgs.length; j++) {
        lines.push('画像' + (j + 1) + '：' + (has(imgs[j].caption) ? s(imgs[j].caption) : '（説明未記入）'));
      }
      out.push('', '■ 添付画像', lines.join('\n'));
    }

    /* ---- 会社概要 ---- */
    var company = pairs([
      ['会社名',   has(d.company_kana) ? s(d.company) + '（' + s(d.company_kana) + '）' : d.company],
      ['所在地',   d.location],
      ['代表者',   d.representative],
      ['設立',     d.founded],
      ['事業内容', d.business],
      ['URL',      d.company_url]
    ]);
    if (company.length) out.push('', '■ 会社概要', company.join('\n'));

    /* ---- 問い合わせ先 ---- */
    var contact = pairs([
      ['担当',     joinNonEmpty([d.contact_dept, d.contact_name], ' ')],
      ['TEL',      d.contact_tel],
      ['Email',    d.contact_email],
      ['受付時間', d.contact_hours]
    ]);
    if (contact.length) {
      var head = has(d.company) ? s(d.company) : null;
      out.push('', '■ 本件に関するお問い合わせ');
      if (head) out.push(head);
      out.push(contact.join('\n'));
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function joinNonEmpty(list, sep) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (has(list[i])) out.push(s(list[i]));
    return out.join(sep);
  }

  /* features は [{title, body}] の配列。中身が空のものは落とす */
  function normalizeFeatures(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length; i++) {
      var f = v[i] || {};
      if (has(f.title) || has(f.body)) {
        out.push({ title: has(f.title) ? s(f.title) : '（見出し未記入）', body: s(f.body) });
      }
    }
    return out;
  }

  function normalizeImages(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length; i++) {
      var g = v[i] || {};
      if (has(g.path)) out.push({ path: s(g.path), caption: s(g.caption) });
    }
    return out;
  }

  /**
   * 表示する全文。手で直したもの（body_override）があればそちら。
   */
  function currentText(d) {
    return has(d && d.body_override) ? s(d.body_override) : buildDraft(d);
  }

  /**
   * 手元の AI に渡す指示文を組み立てる。草案の全文をそのまま差し込む。
   *
   * 直してよいのは日本語の表現だけ。事実を書き換えられると、
   * 掲載した内容と実態がずれる。そこを最初に、はっきり書く。
   */
  function buildPrompt(text) {
    return [
      'あなたは日本語のプレスリリースを校正する編集者です。',
      '以下は、PR TIMES へ掲載するプレスリリースの草案です。',
      '日本語の表現だけを整えてください。',
      '',
      '【必ず守ること】',
      '1. 事実・数字・固有名詞を変えない。',
      '   会社名、人名、部署名、日付、時刻、金額、人数、場所、URL、メールアドレス、',
      '   電話番号は、一字一句そのまま残すこと。',
      '2. 書かれていない情報を追加しない。',
      '   実績、効果、業界初などの表現を、こちらの判断で足さない。',
      '   足りないと感じた箇所は、補わずにそのままにすること。',
      '3. 情報を削らない。要約しない。',
      '4. 見出し（■で始まる行）と段落の構成、項目の並び順を変えない。',
      '5. PR TIMES にそのまま掲載できる、自然で読みやすい日本語にする。',
      '   誤字脱字、二重敬語、係り受けのねじれ、冗長な言い回しを直す。',
      '   誇張した表現や、話し言葉は、落ち着いた書き言葉に直す。',
      '6. 出力は修正後の本文のみ。前置き・解説・変更点の一覧は付けない。',
      '',
      '【草案】',
      '----------------------------------------',
      s(text),
      '----------------------------------------'
    ].join('\n');
  }

  /**
   * 出す前の確認。埋まっていないと掲載時に困る項目を挙げる。
   * 止めはしない（あとから足せるものもある）。挙げるだけ。
   */
  function missing(d) {
    d = d || {};
    var out = [];
    if (!has(d.title))   out.push('タイトル');
    if (!has(d.company)) out.push('会社・団体名');
    if (!has(d.summary)) out.push('発表内容');
    if (!normalizeFeatures(d.features).length) out.push('特徴');
    if (!has(d.contact_email) && !has(d.contact_tel)) out.push('問い合わせ先（メールか電話のどちらか）');
    return out;
  }

  return {
    KINDS: KINDS,
    STATUSES: STATUSES,
    VENUES: VENUES,
    FEES: FEES,
    kindOf: kindOf,
    formOf: formOf,
    shows: shows,
    labelOf: labelOf,
    statusOf: statusOf,
    venueOf: venueOf,
    timeOptions: timeOptions,
    jpDate: jpDate,
    composeEventDate: composeEventDate,
    composePlace: composePlace,
    composePrice: composePrice,
    composed: composed,
    titleExamples: titleExamples,
    fromProfile: fromProfile,
    buildDraft: buildDraft,
    currentText: currentText,
    buildPrompt: buildPrompt,
    missing: missing,
    normalizeFeatures: normalizeFeatures,
    normalizeImages: normalizeImages
  };
});
