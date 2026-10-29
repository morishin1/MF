// Explicit owned-site publication. Rendering or internal registration never publishes.
(function () {
  "use strict";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ENDPOINT = "/api/marketing/site-publication";
  const CHECK_LABELS = {
    pending: "サイトの定時同期を待っています",
    verified: "公開内容の一致を確認しました",
    unavailable: "公開ページを取得できませんでした。時間をおいて再確認してください",
    content_mismatch: "公開ページの内容が一致しません。同期状況と公開内容を確認してください",
    source_changed: "原本が変更されています。公開担当者に確認してください",
    too_large: "公開ページが検証できるサイズの上限を超えています。管理担当者に確認してください",
    invalid_target: "公開先の設定を確認できません。管理担当者に確認してください"
  };
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  };
  function mount(root, reference) {
    const id = reference?.id;
    let active = true, generation = 0, busy = false, data = null;
    let approved = false, error = "", uncertain = false;
    const valid = () => active && UUID.test(String(id || ""));
    const expectedUrl = valid() ? "https://8grp.co.jp/news/press-mkt-" + id.replace(/-/g, "").toLowerCase() + "/" : "";
    const publicUrl = value => value === expectedUrl ? value : null;
    const api = (options) => window.API.api(ENDPOINT + (options ? "" : "?id=" + encodeURIComponent(id)), options);
    const button = (label, fn, disabled = false) => {
      const b = el("button", label, "mpr-secondary"); b.type = "button";
      b.disabled = busy || disabled;
      b.onclick = () => { if (active && !busy && !b.disabled) return fn(); };
      return b;
    };
    function render() {
      if (!active) return;
      root.replaceChildren();
      root.className = "mpr-card";
      root.setAttribute("aria-label", "自社サイトへの公開と結果確認");
      root.append(el("h3", "自社サイトへの公開と結果確認"));
      root.append(el("p", "対象は 8grp.co.jp のお知らせです。PR TIMES・SNS・YouTubeには投稿しません。", "mpr-hint"));
      if (!valid()) { root.append(el("p", "保存済みの本登録原稿を開き直してください。", "mpr-error")); return; }
      if (!data) root.append(el("p", busy ? "公開先・権限・保存先を確認しています…" : "公開先の状態を取得してください。", "mpr-hint"));
      if (data) {
        const preview = data.preview, publication = data.publication;
        if (!data.ready || !data.canPublish) root.append(el("p", data.reason || "公開機能の準備・権限を確認してください。", "mpr-hint"));
        if (preview) {
          root.append(el("h4", "外部公開される内容を確認"));
          root.append(el("p", "タイトル：" + (preview.title || "")));
          root.append(el("p", "概要：" + (preview.summary || "")));
          root.append(el("pre", preview.bodyText || "", "mpr-preview"));
          root.append(el("p", "会社情報・問い合わせ先（氏名・電話番号・メールアドレス）を含む以下の原稿内容が、一般公開されます。公開してよい情報か確認してください。", "mpr-hint"));
          const exposure = el("ul");
          for (const item of Array.isArray(preview.exposure) ? preview.exposure : []) exposure.append(el("li", item));
          root.append(exposure);
          root.append(el("p", "画像本体はアップロードされません。本文に画像説明が含まれていても、画像掲載済みではありません。", "mpr-hint"));
          const url = publicUrl(preview.publicUrl);
          root.append(el("p", "公開先URL：" + (url || "公開先URLを確認できません。再取得してください。"), "mpr-hint"));
        }
        if (publication) {
          const labels = {
            pending: "サイト反映待ち（毎朝8時JSTの定時同期）",
            verified: "公開ページの内容一致を確認済み",
            changed: "公開設定または公開ページに変更があります。内容を確認してください。"
          };
          const status = el("p", Object.hasOwn(labels, publication.state) ? labels[publication.state] : "公開状態を確認できません。再取得してください。", "mpr-notice");
          status.setAttribute("role", "status"); root.append(status);
          root.append(el("p", "保存成功だけではサイト反映完了ではありません。同期の遅延・失敗時は反映を待ってから再確認してください。", "mpr-hint"));
          if (publication.requestedAt) root.append(el("p", "公開設定の受付：" + publication.requestedAt, "mpr-hint"));
          if (publication.checkedAt) root.append(el("p", "最終確認：" + publication.checkedAt, "mpr-hint"));
          if (publication.verifiedAt) root.append(el("p", "内容一致の確認日時：" + publication.verifiedAt, "mpr-hint"));
          if (publication.lastCheck) root.append(el("p", "確認結果：" + (Object.hasOwn(CHECK_LABELS, publication.lastCheck) ? CHECK_LABELS[publication.lastCheck] : "確認できません。管理担当者に確認してください"), "mpr-hint"));
          const url = publicUrl(publication.url);
          if (url) {
            const a = el("a", "公開先ページを別のタブで開く", "mpr-secondary");
            a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; root.append(a);
          }
          root.append(button("公開ページの反映を確認", () => mutate("verify"), !data.ready));
        } else if (data.ready && data.canPublish && preview) {
          const label = el("label", undefined, "mpr-hint");
          const confirm = el("input"); confirm.type = "checkbox"; confirm.checked = approved; confirm.disabled = busy || uncertain;
          confirm.setAttribute("aria-label", "原稿・公開先・使用許可・公開する連絡先を確認しました");
          const caption = el("span", "原稿・公開先・使用許可・公開する連絡先を確認しました。自社サイトで一般公開することを承認します。");
          label.append(confirm, caption); root.append(label);
          const publish = button("確認した内容で自社サイトへ公開を依頼", () => mutate("publish"), !approved || uncertain || !publicUrl(preview.publicUrl) || !preview.hash || !Number.isSafeInteger(data.version));
          publish.className = "mpr-primary";
          confirm.onchange = () => {
            if (!active || busy || uncertain) return;
            approved = confirm.checked === true;
            publish.disabled = !approved || !publicUrl(preview.publicUrl) || !preview.hash || !Number.isSafeInteger(data.version);
          };
          root.append(publish);
          root.append(el("p", "このボタンだけが公開設定を行います。保存・プレビュー・本登録では公開されません。設定後は定時同期の反映を確認します。", "mpr-hint"));
        }
      }
      if (error) { const p = el("p", error, "mpr-error"); p.setAttribute("role", "alert"); root.append(p); }
      root.append(button(busy ? "処理中…" : "公開状態を再取得", refresh));
    }
    function accept(result) {
      if (!result || result.id !== id) throw Error("原稿と公開結果の対応を確認できません。");
      data = result; approved = false;
    }
    async function refresh() {
      if (!valid() || busy) return;
      const token = ++generation; busy = true; error = ""; approved = false; render();
      try {
        const result = await api();
        if (!active || token !== generation) return;
        accept(result); uncertain = false;
      } catch (e) {
        if (!active || token !== generation) return;
        error = e?.body?.hint || e?.hint || "公開先の状態を取得できません。権限・接続を確認して再取得してください。";
      } finally {
        if (active && token === generation) { busy = false; render(); }
      }
    }
    async function mutate(action) {
      if (!valid() || busy || !data?.ready) return;
      if (action === "publish" && (!data.canPublish || data.publication || !approved || uncertain || !data.preview?.hash || !publicUrl(data.preview.publicUrl))) return;
      if (action === "verify" && !data.publication) return;
      const body = action === "publish" ? { action, id, version: data.version, previewHash: data.preview.hash, confirmed: true } : { action, id };
      const token = ++generation; busy = true; error = ""; approved = false; render();
      try {
        const result = await api({ method: "POST", body });
        if (!active || token !== generation) return;
        accept(result); uncertain = false;
      } catch (e) {
        if (!active || token !== generation) return;
        uncertain = true;
        error = (e?.body?.hint || e?.hint || "操作結果を確認できませんでした。") + " 同じ公開操作を繰り返さず、『公開状態を再取得』で保存結果を確認してください。";
      } finally {
        if (active && token === generation) { busy = false; render(); }
      }
    }
    render(); if (valid()) refresh();
    return () => { active = false; generation++; };
  }
  window.MarketingSitePublication = { mount };
})();
