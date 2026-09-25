/**
 * GASウェブアプリ呼び出しラッパー
 * - Content-Type を text/plain にすることでCORSプリフライトを回避（GASはOPTIONSに応答できない）
 * - ネットワークエラー・5xx は指数バックオフでリトライ
 * - GAS側のエラー（success: false）はそのままメッセージを投げる
 * - すべての呼び出しにライセンスキーを添える。キーが無効と言われたら 'license-invalid' イベントで画面側に知らせる
 */

import { getLicenseKey } from './license.js?v=2.2.0';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function gasCall(action, payload = {}) {
  const url = window.APP_CONFIG.GAS_URL;
  if (!url) throw new Error('config.js の GAS_URL が設定されていません');

  for (let attempt = 1; ; attempt++) {
    let retriable = false;
    try {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, licenseKey: getLicenseKey(), ...payload }),
          redirect: 'follow',
        });
      } catch (netErr) {
        retriable = true; // ネットワーク断は一時障害としてリトライ
        throw new Error('サーバーへの接続に失敗しました: ' + netErr.message);
      }
      if (!res.ok) {
        // GASは正常時ほぼ200を返す。429/5xxのみ一時障害としてリトライ
        retriable = res.status === 429 || res.status >= 500;
        const text = await res.text().catch(() => '');
        throw new Error(`サーバーエラー (${res.status}): ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      if (!data.success && /^LICENSE_/.test(data.code || '')) {
        // キー無効・停止・期限切れ・上限超過。リトライしても変わらない
        const err = new Error(data.message || 'ライセンスキーを確認してください');
        err.code = data.code;
        if (data.code !== 'LICENSE_LIMIT') {
          window.dispatchEvent(new CustomEvent('license-invalid', { detail: { message: err.message } }));
        }
        throw err;
      }
      if (!data.success) {
        // Gemini側の429/5xxはGAS内でもリトライ済み。それでも残っていれば間を置いて再試行
        retriable = /429|5\d\d/.test(data.message || '');
        throw new Error(data.message || '不明なエラー');
      }
      return data.data;
    } catch (err) {
      if (!retriable || attempt >= MAX_RETRIES) throw err;
    }
    await sleep(RETRY_DELAY_MS * attempt);
  }
}
