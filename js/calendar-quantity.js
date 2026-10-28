(function (root) {
  "use strict";
  // One optional field: "10件", "3社", "0", or empty. Never an actual count.
  function parse(value) {
    const input = String(value ?? "").normalize("NFKC").trim();
    if (!input) return { plannedQuantity: null, plannedQuantityUnit: null };
    const match = input.match(/^(\d+(?:\.\d+)?|\.\d+)\s*([^\d\s.+-][^\r\n\t]{0,9})?$/);
    if (!match || /^[\d.]+\s*[eE][+-]?\d+$/.test(input)) throw Error("数字は0以上で入力してください（例：10件、3社）。数えない作業は空欄で構いません");
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount > 1e9) throw Error("数字は10億以下で入力してください");
    return { plannedQuantity: amount, plannedQuantityUnit: match[2]?.trim() || null };
  }
  function format(value, unit) {
    if (value == null || value === "") return "";
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 && amount <= 1e9 ? String(amount) + String(unit || "") : "";
  }
  root.CalendarQuantity = Object.freeze({ parse, format });
})(window);
