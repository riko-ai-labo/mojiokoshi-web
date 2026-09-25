/**
 * ライセンスキーの保持（このブラウザに記憶して、2回目以降は入力不要にする）
 * 照合そのものはサーバー（GAS）側で毎回行う。ここは「持っておく」だけ。
 */

const KEY = 'mojiokoshi.licenseKey.v1';
let current = '';

/** 入力ゆれを吸収（サーバー側 normalizeKey_ と同じ規則） */
export function normalizeKey(key) {
  return String(key || '').toUpperCase()
    .replace(/[\s　]/g, '')
    .replace(/[‐-―−ー－ｰ]/g, '-');
}

export function getLicenseKey() {
  if (current) return current;
  try {
    current = localStorage.getItem(KEY) || '';
  } catch { /* プライベートモード等 */ }
  return current;
}

export function setLicenseKey(key) {
  current = normalizeKey(key);
  try {
    if (current) localStorage.setItem(KEY, current);
    else localStorage.removeItem(KEY);
  } catch { /* 記憶できなくても今回のセッションでは使える */ }
}

export function clearLicenseKey() {
  setLicenseKey('');
}
