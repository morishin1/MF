// /sales/proposals — 操作が進まない理由を、技術コードではなく次の行動で伝える。
(function () {
  "use strict";
  const issue = (title, message, field) => ({ title, message, field });
  const filled = (v) => String(v ?? "").trim().length > 0;
  const isDate = (v) => filled(v) && Number.isFinite(new Date(v).getTime());

  function validate(action, body, context = {}) {
    const v = body || {};
    switch (action) {
      case "sent":
      case "mail":
      case "reply":
      case "call":
        if (!isDate(v.occurredAt))
          return issue("日時を入力してください", "実施した日時を入力・確認してから記録してください。", "m-at");
        if (action === "call") {
          if (!filled(v.result)) return issue("電話の結果が未選択です", "「通話できた」「不在」など、電話の結果を選んでください。", "m-result");
          if (v.result === "connected" && !filled(v.outcome))
            return issue("通話内容が未選択です", "先方と話した結果を選んでください。", "m-out");
          if (context.callNeedsAt && !isDate(v.nextAt))
            return issue("先方の希望日時が未入力です", "折り返し・再連絡の日時を入力してください。", "m-nextat");
        }
        if (action === "reply" && !filled(v.outcome))
          return issue("返信内容が未選択です", "企業からどのような回答があったかを選んでください。", "m-out");
        return null;
      case "meeting":
        if (!filled(v.result)) return issue("面談の内容が未選択です", "面談の結果を選んでください。", "m-result");
        if (v.result === "scheduled" && !isDate(v.nextAt))
          return issue("面談日時が未入力です", "面談予定を登録する場合は日時を入力してください。", "m-nextat");
        return null;
      case "decision":
        if (!filled(v.result)) return issue("管理者の判断が未選択です", "判断を選んでください。", "m-result");
        if (v.result === "continue" && !isDate(v.nextAt))
          return issue("次の連絡日時が未入力です", "継続する場合は次に連絡する日時を入力してください。", "m-nextat");
        return null;
      case "result":
        return filled(v.status) ? null : issue("提案の結果が未選択です", "結果を選んでから保存してください。", "m-st");
      case "memo":
        return filled(v.note) ? null : issue("メモが未入力です", "内容を入力してください。", "m-note");
      case "task_add":
        if (!filled(v.title)) return issue("タスク名が未入力です", "追加したいタスクの内容を入力してください。", "m-title");
        if (!isDate(v.dueAt)) return issue("タスクの期限が未入力です", "完了予定の日時を入力してください。", "m-due");
        return null;
      case "task_due":
        if (!isDate(v.dueAt)) return issue("変更後の期限が未入力です", "新しい期限を入力してください。", "m-due");
        if (!filled(v.reason)) return issue("変更理由が未入力です", "変更理由を入力し、履歴に残してください。", "m-note");
        return null;
      case "task_done":
      case "task_cancel":
        return filled(v.reason || v.note) ? null
          : issue(action === "task_done" ? "完了内容が未入力です" : "取り消し理由が未入力です",
            action === "task_done" ? "何をしたかを入力してください。" : "取り消す理由を入力してください。", "m-note");
      case "contact":
        if (v.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contactEmail.trim()))
          return issue("メールアドレスの形式を確認してください", "正しいメールアドレスを入力してください。", "m-cmail");
        return null;
      case "assign":
        return v.ownerId === context.currentOwner
          ? issue("担当者が変わっていません", "変更後の担当者を選んでください。", "m-owner") : null;
      case "new":
        if (!filled(v.companyName)) return issue("企業名が未入力です", "提案先の企業名を入力してください。", "n-company");
        if (!filled(v.title)) return issue("提案内容が未入力です", "何を提案するか入力してください。", "n-title");
        if (v.sentAt && !isDate(v.sentAt)) return issue("提案日時を確認してください", "日時の入力形式を確認してください。", "n-sent");
        if (v.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contactEmail.trim()))
          return issue("メールアドレスの形式を確認してください", "正しいメールアドレスを入力してください。", "n-cmail");
        return null;
      case "transfer":
        if (!filled(v.ownerId)) return issue("引継ぎ先が未選択です", "次の担当者を選んでください。", "m-howner");
        if (!filled(v.decision)) return issue("判断が未選択です", "引継ぎの判断を選んでください。", "m-hdecision");
        if (!filled(v.reason)) return issue("引継ぎ理由が未入力です", "引継ぎの背景を記入してください。", "m-hreason");
        if (!filled(v.nextAction)) return issue("次の対応が未入力です", "引き継ぐ担当者が次に何をするか記入してください。", "m-hnext");
        if (v.nextAt && !isDate(v.nextAt)) return issue("対応期限を確認してください", "日時の入力形式を確認してください。", "m-hdue");
        return null;
      case "cs_decision":
        if (!filled(v.decision)) return issue("CS判断が未選択です", "進行・保留・見送りから判断を選択してください。", "m-cdecision");
        if (!filled(v.reason)) return issue("判断理由が未入力です", "企業の反応と判断理由を記入してください。", "m-creason");
        if (!filled(v.nextAction)) return issue("次の対応が未入力です", "次の担当者がすることを記入してください。", "m-cnext");
        return null;
      default:
        return null;
    }
  }
  const codeLabels = {
    forbidden:"この案件を変更する権限がありません。現在の担当者または管理者へ依頼してください。",
    readonly:"ほかの担当者の提案は閲覧のみです。編集は現在の担当者に依頼してください。",
    not_connected:"先に電話結果「通話できた」、または企業からの返信を記録してください。",
    not_sent_or_closed:"企業への提案送信が完了し、対応中の案件だけを引き継げます。",
    not_cs:"CS担当者への正式引継ぎ後に、CSの判断を記録してください。",
    needs_record:"電話・メールなどの実施記録を入力すると、このタスクは自動で完了になります。",
    task_closed:"完了・取消済みのタスクは変更できません。履歴を確認してください。",
    bad_owner:"Salesを利用できる在籍中の社員を担当者に選んでください。",
    nothing_to_update:"変更内容がありません。値を変更してから保存してください。",
    not_ready:"システムの準備が完了していません。管理者へ連絡してください。",
    owner_changed:"ほかの担当者が先に変更しました。画面を更新してください。",
    closed:"終了済みの案件は更新できません。担当者または管理者へ確認してください。",
    invalid_body:"必須項目や日時を確認し、入力し直してください。",
    handoff_blocked:"引継ぎの前提条件を満たしていません。提案送信・通話記録・CS判断を確認してください。",
  };
  const technical = {
    cs_contact_required:"先に通話結果または返信を記録してください。",
    cs_approval_required:"CS担当が進行判断を記録してから引き継いでください。",
    invalid_handoff_transition:"順番どおり「提案 → CS → クロージング」に引き継いでください。",
    target_not_in_configured_team:"指定した担当者がCS・クロージングの対象メンバーに登録されていません。",
    proposal_not_active:"この提案は終了しているため、引き継げません。",
  };
  function formatError(e) {
    const raw = String(e?.hint || e?.detail || e?.message || "").trim();
    if (technical[raw]) return technical[raw];
    if (technical[String(e?.code || "")]) return technical[e.code];
    const code = String(e?.code || "");
    if (code === "forbidden" || code === "readonly") return codeLabels[code];
    if (codeLabels[code]) {
      // エラー本文が具体的に操作を説明していれば本文を優先。そうでなければ翻訳を使う。
      const technicalBody = /^(?:[a-z_]+|(?:Postgrest|SQLSTATE|PGRST|ERROR|relation|column|function)\b)/i.test(raw);
      return raw && !technicalBody && /[ぁ-んァ-ン一-龯]/.test(raw) ? raw : codeLabels[code];
    }
    return /[ぁ-んァ-ン一-龯]/.test(raw) && !/\b(?:PGRST|SQLSTATE|permission denied)\b/i.test(raw)
      ? raw : "操作を完了できませんでした。入力内容を確認し、解消しない場合は管理者へ連絡してください。";
  }
  window.SalesProposalFeedback = Object.freeze({ validate, formatError });
}());
