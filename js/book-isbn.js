// ISBN-10 and ISBN-13 refer to the same edition. The catalogue stores the ISBN-13.
export function compactIsbn(value) {
  return String(value ?? "").normalize("NFKC").trim().toUpperCase()
    .replace(/^ISBN(?:-1[03])?\s*[:：]?\s*/i, "").replace(/[\s\-‐‑‒–—―−ー]/g, "");
}

function checkDigit(firstTwelve) {
  const sum = [...firstTwelve].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
  return String((10 - sum % 10) % 10);
}

export function normalizeIsbn(value) {
  const isbn = compactIsbn(value);
  if (/^97[89]\d{10}$/.test(isbn)) return checkDigit(isbn.slice(0, 12)) === isbn[12] ? isbn : null;
  if (!/^\d{9}[\dX]$/.test(isbn)) return null;
  const sum = [...isbn].reduce((total, digit, i) => total + (digit === "X" ? 10 : Number(digit)) * (10 - i), 0);
  if (sum % 11) return null;
  const prefix = "978" + isbn.slice(0, 9);
  return prefix + checkDigit(prefix);
}
