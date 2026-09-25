// 実行方法: node test/license.test.mjs
// gas/Code.gs をそのまま読み込み、Apps Script のサービスを模擬してライセンス照合を検証する
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '../gas/Code.gs'), 'utf8');

let passed = 0;
let failed = 0;
function check(cond, label, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok: ${label}`);
  } else {
    failed++;
    console.error(`  NG: ${label} ${extra}`);
  }
}

// ---- Apps Script の模擬
function makeSheet(name, rows = []) {
  return {
    name,
    rows, // 2次元配列（1行目はヘッダー）
    frozen: 0,
    getLastRow() { return this.rows.length; },
    appendRow(r) { this.rows.push([...r]); },
    setFrozenRows(n) { this.frozen = n; },
    getRange(row, col, numRows = 1, numCols = 1) {
      const sheet = this;
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const line = [];
            for (let c = 0; c < numCols; c++) line.push(sheet.rows[row - 1 + r]?.[col - 1 + c] ?? '');
            out.push(line);
          }
          return out;
        },
        setValues(values) {
          values.forEach((line, r) => line.forEach((v, c) => {
            while (sheet.rows.length < row + r) sheet.rows.push([]);
            // 先頭の ' はスプレッドシートでは「文字列として入力」の意味で、値には残らない
            sheet.rows[row - 1 + r][col - 1 + c] = typeof v === 'string' ? v.replace(/^'/, '') : v;
          }));
        },
        setValue(v) { this.setValues([[v]]); },
        clearContent() {
          for (let r = 0; r < numRows; r++) for (let c = 0; c < numCols; c++) {
            if (sheet.rows[row - 1 + r]) sheet.rows[row - 1 + r][col - 1 + c] = '';
          }
        },
      };
    },
  };
}

function makeEnv(now) {
  const book = {
    sheets: [makeSheet('シート1')], // 1枚目は辞書
    getSheets() { return this.sheets; },
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; },
    insertSheet(n, index) {
      const s = makeSheet(n);
      this.sheets.splice(index, 0, s);
      return s;
    },
  };
  const cache = new Map();
  const clock = { now };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const props = { GEMINI_API_KEY: 'test-key', DICT_SHEET_ID: 'book1' };
  const sandbox = {
    Date: FakeDate,
    JSON, Math, Number, String, Object, Array, Error, RegExp, isNaN,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null }) },
    SpreadsheetApp: { openById: () => book },
    CacheService: { getScriptCache: () => ({
      get: (k) => (cache.has(k) ? cache.get(k) : null),
      put: (k, v) => cache.set(k, v),
    }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      sleep() {},
      formatDate(d, tz, fmt) {
        const j = new Date(d.getTime() + 9 * 3600 * 1000); // JST
        const p = (n) => String(n).padStart(2, '0');
        return fmt
          .replace('yyyy', j.getUTCFullYear()).replace('MM', p(j.getUTCMonth() + 1))
          .replace('dd', p(j.getUTCDate())).replace('HH', p(j.getUTCHours())).replace('mm', p(j.getUTCMinutes()));
      },
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }),
    },
    Logger: { log() {} },
    UrlFetchApp: { fetch() { throw new Error('ネットワークは使わないテストです'); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  // Gemini呼び出しだけ差し替える（ライセンス層の検証が目的）
  vm.runInContext(`
    var __calls = [];
    var __failNext = false;
    transcribe = function (d) { __calls.push('transcribe'); if (__failNext) { __failNext = false; throw new Error('Gemini APIエラー (500)'); } return { text: 'ok' }; };
    startUpload = function () { __calls.push('startUpload'); return { uploadUrl: 'x' }; };
  `, sandbox);
  const post = (body) => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  return { sandbox, book, cache, clock, post, run: (src) => vm.runInContext(src, sandbox) };
}

const T0 = Date.UTC(2026, 8, 19, 3, 0); // 2026-09-19 12:00 JST

console.log('キーの発行');
const env = makeEnv(T0);
{
  env.run('issueLicenseKeys()'); // タブが無い状態 → 作るだけ
  const lic = env.book.getSheetByName('ライセンス');
  check(!!lic && lic.rows.length === 1, 'ライセンスタブがヘッダー付きで作られる');
  check(env.book.sheets[0].name === 'シート1', '辞書シート（1枚目）の位置は変わらない');
  lic.rows.push(['', '山田花子', '', '', '', '', '', '', '']);
  lic.rows.push(['', '期限切れさん', '', new Date(Date.UTC(2026, 8, 17, 15, 0)), '', '', '', '', '']); // 9/18 JST
  lic.rows.push(['', '停止さん', '停止', '', '', '', '', '', '']);
  lic.rows.push(['', '上限さん', '', '', 20, '', '', '', '']);
  lic.rows.push(['', '今日までさん', '', '2026/09/19', '', '', '', '', '']);
  const n = env.run('issueLicenseKeys()');
  check(n === 5, '名前のある5行にキーが発行される', `n=${n}`);
  check(/^MOJI-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(lic.rows[1][0]), 'キーの形式 MOJI-XXXX-XXXX-XXXX', lic.rows[1][0]);
  check(lic.rows[1][2] === '有効' && lic.rows[3][2] === '停止', '状態が空なら「有効」、既存の「停止」は保持');
  const before = lic.rows[1][0];
  check(env.run('issueLicenseKeys()') === 0 && lic.rows[1][0] === before, '再実行しても既存キーは変わらない');
}
const lic = env.book.getSheetByName('ライセンス');
const [kOk, kExpired, kStopped, kLimit, kToday] = [1, 2, 3, 4, 5].map((i) => lic.rows[i][0]);

console.log('照合');
{
  let r = env.post({ action: 'startUpload', fileName: 'a', fileSize: 1, mimeType: 'audio/mp3' });
  check(!r.success && r.code === 'LICENSE_REQUIRED', 'キー無しでは何も実行できない', JSON.stringify(r));
  r = env.post({ action: 'dictGet', licenseKey: 'MOJI-AAAA-AAAA-AAAA' });
  check(!r.success && r.code === 'LICENSE_INVALID', '存在しないキーは拒否');
  r = env.post({ action: 'licenseCheck', licenseKey: kOk });
  check(r.success && r.data.name === '山田花子', '正しいキーで通り、名前が返る', JSON.stringify(r));
  r = env.post({ action: 'licenseCheck', licenseKey: ' ' + kOk.toLowerCase().replace(/-/g, '－') + '　' });
  check(r.success, '小文字・全角ハイフン・空白まじりでも通る', JSON.stringify(r));
  r = env.post({ action: 'licenseCheck', licenseKey: kStopped });
  check(!r.success && /停止/.test(r.message), '停止中のキーは拒否');
  r = env.post({ action: 'licenseCheck', licenseKey: kExpired });
  check(!r.success && /期限/.test(r.message), '期限切れのキーは拒否');
  r = env.post({ action: 'licenseCheck', licenseKey: kToday });
  check(r.success && r.data.expires === '2026-09-19', '期限当日はまだ使える', JSON.stringify(r));
  r = env.post({ action: 'ping' });
  check(r.success, 'pingだけはキー無しで応答（疎通確認用）');
  const leaked = JSON.stringify(env.post({ action: 'licenseCheck', licenseKey: kOk }));
  check(!leaked.includes(kLimit) && !leaked.includes('row'), '応答に他人のキーや台帳の内部情報が含まれない');
}

console.log('停止の反映と期限切れ');
{
  lic.rows[1][2] = '停止'; // 管理者が停止に変更
  let r = env.post({ action: 'dictGet', licenseKey: kOk });
  check(r.success, '停止直後はキャッシュで数分だけ通る（仕様）');
  env.cache.clear(); // キャッシュ期限切れ相当
  r = env.post({ action: 'dictGet', licenseKey: kOk });
  check(!r.success && r.code === 'LICENSE_INVALID', 'キャッシュが切れると停止が効く');
  lic.rows[1][2] = '有効';

  env.post({ action: 'licenseCheck', licenseKey: kToday }); // キャッシュに載せる
  env.clock.now = T0 + 24 * 3600 * 1000; // 翌日
  r = env.post({ action: 'dictGet', licenseKey: kToday });
  check(!r.success && /期限/.test(r.message), 'キャッシュ中でも期限を過ぎたら拒否');
  env.clock.now = T0;
}

console.log('利用量の集計と上限');
{
  env.cache.clear();
  const body = { action: 'transcribe', licenseKey: kLimit, audioStart: 0, audioEnd: 600 }; // 10分
  let r = env.post(body);
  check(r.success && lic.rows[4][6] === 10 && lic.rows[4][5] === '2026-09', '10分ぶんが今月の利用に加算される', JSON.stringify(lic.rows[4]));
  env.run('__failNext = true');
  r = env.post(body);
  check(!r.success && lic.rows[4][6] === 10, 'Geminiが失敗した回は加算されない');
  r = env.post(body);
  check(r.success && lic.rows[4][6] === 20, '上限ちょうどまでは使える');
  const calls = env.run('__calls.length');
  r = env.post(body);
  check(!r.success && r.code === 'LICENSE_LIMIT' && env.run('__calls.length') === calls, '上限超えは実行前に止まる（Geminiを呼ばない）', JSON.stringify(r));
  env.clock.now = Date.UTC(2026, 9, 1, 3, 0); // 10月
  r = env.post(body);
  check(r.success && lic.rows[4][6] === 10 && lic.rows[4][5] === '2026-10', '月が変わると集計がリセットされる', JSON.stringify(lic.rows[4]));
  env.clock.now = T0;
  const log = env.book.getSheetByName('利用ログ');
  check(log && log.rows.length === 4 && log.rows[1][1] === '上限さん' && log.rows[1][2] === kLimit.slice(-4),
    '利用ログに名前とキー末尾4桁だけが残る', JSON.stringify(log?.rows));
}

console.log('アップロードURLの安全性');
{
  const strip = (u) => env.run(`stripApiKey_(${JSON.stringify(u)})`);
  const base = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
  check(strip(base + '?key=SECRET&upload_id=AbC-1_x&upload_protocol=resumable') === base + '?upload_id=AbC-1_x&upload_protocol=resumable',
    '先頭の key= を取り除く');
  check(strip(base + '?upload_id=A1&key=SECRET&upload_protocol=resumable') === base + '?upload_id=A1&upload_protocol=resumable',
    '途中の key= を取り除く');
  check(!strip(base + '?upload_id=A1&upload_protocol=resumable&key=SECRET').includes('SECRET'), '末尾の key= を取り除く');
  const bad = (u) => { try { env.run(`assertUploadUrl_(${JSON.stringify(u)})`); return false; } catch { return true; } };
  check(!bad(base + '?upload_id=A1&upload_protocol=resumable'), '正しいアップロードURLは通す');
  check(bad('https://evil.example.com/upload/v1beta/files?upload_id=A1'), '他のサイトのURLは拒否（GASを踏み台にさせない）');
  check(bad(base + '?upload_protocol=resumable'), 'upload_id の無いURLは拒否');
  check(bad('http://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=A1'), 'httpは拒否');
  const r = env.post({ action: 'uploadResult', uploadUrl: base + '?upload_id=A1' });
  check(!r.success && r.code === 'LICENSE_REQUIRED', 'uploadResult もキー無しでは使えない');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
