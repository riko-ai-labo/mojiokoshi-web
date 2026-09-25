// ローカル確認用: 静的ファイル配信 + GASの模擬（ライセンス照合と辞書だけ。Geminiは呼ばない）
// 実行: node test/mock-server.mjs → http://localhost:8000   テスト用キー: MOJI-TEST-TEST-TEST（停止中の例: MOJI-STOP-STOP-STOP）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const norm = (k) => String(k || '').toUpperCase().replace(/\s/g, '');
let dict = [{ surface: 'クレアカ', reading: 'くれあか', wrongs: ['クレア化'] }];

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/gas') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const d = JSON.parse(body || '{}');
      const key = norm(d.licenseKey);
      let out;
      if (!key) out = { success: false, code: 'LICENSE_REQUIRED', message: 'ライセンスキーを入力してください' };
      else if (key === 'MOJI-STOP-STOP-STOP') out = { success: false, code: 'LICENSE_INVALID', message: 'このライセンスキーは停止されています。管理者にお問い合わせください' };
      else if (key !== 'MOJI-TEST-TEST-TEST') out = { success: false, code: 'LICENSE_INVALID', message: 'ライセンスキーが正しくありません。入力内容を確認してください' };
      else if (d.action === 'licenseCheck') out = { success: true, data: { name: 'テスト太郎', expires: '2026-12-31', limitMin: null } };
      else if (d.action === 'dictGet') out = { success: true, data: { entries: dict } };
      else if (d.action === 'dictUpdate') { dict = d.entries; out = { success: true, data: { entries: dict } }; }
      else if (d.action === 'promptDefaults') out = { success: true, data: { refine: '（既定の整形の指示）', summarize: '（既定の要約の指示）', maxLength: 4000 } };
      else if (d.action === 'refine') out = { success: true, data: { text: '【整形】指示=' + (d.customPrompt || '既定') + ' / ' + d.text.slice(0, 40) } };
      else if (d.action === 'summarize') out = { success: true, data: { text: '【要約】指示=' + (d.customPrompt || '既定') } };
      else out = { success: false, message: '模擬サーバーでは未対応: ' + d.action };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url.pathname === '/js/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end("window.APP_CONFIG = { GAS_URL: '/gas', OAUTH_CLIENT_ID: 'dummy.apps.googleusercontent.com' };");
    return;
  }
  const file = path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': (TYPES[path.extname(file)] || 'application/octet-stream') + ';charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(8000, () => console.log('http://localhost:8000'));
