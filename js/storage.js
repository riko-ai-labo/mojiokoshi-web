/**
 * ブラウザ内の保存（localStorage）
 *  - 処理中ジョブ: チャンクごとの文字起こし結果。タブを閉じたり失敗しても、同じファイルなら続きから再開できる
 *  - 前回の結果: 完了した文字起こし・整形・要約。保存し忘れて閉じても復元できる
 *  - ヒント: 前回入力した「内容のヒント」
 *  - カスタム指示: 整形・要約の指示（このブラウザだけに保存）
 * どれも無くても動くよう、読み書きはすべて try/catch で包む。
 */

const JOB_KEY = 'mojiokoshi.job.v2';
const RESULT_KEY = 'mojiokoshi.lastResult.v2';
const HINT_KEY = 'mojiokoshi.hint.v2';

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // 容量超過など。動作には影響させない
  }
}

/** ファイルの同一性キー（名前・サイズ・更新日時） */
export function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export function loadJob() {
  return read(JOB_KEY);
}

export function saveJob(job) {
  return write(JOB_KEY, job);
}

export function clearJob() {
  write(JOB_KEY, null);
}

export function loadResult() {
  return read(RESULT_KEY);
}

export function saveResult(result) {
  return write(RESULT_KEY, result);
}

export function clearResult() {
  write(RESULT_KEY, null);
}

export function loadHint() {
  return read(HINT_KEY) || '';
}

export function saveHint(hint) {
  write(HINT_KEY, hint || null);
}

// カスタム指示（整形・要約）。空文字なら既定の指示で処理される
const PROMPTS_KEY = 'mojiokoshi.prompts.v1';

export function loadPrompts() {
  const p = read(PROMPTS_KEY) || {};
  return { refine: p.refine || '', summarize: p.summarize || '' };
}

export function savePrompts(prompts) {
  const refine = (prompts.refine || '').trim();
  const summarize = (prompts.summarize || '').trim();
  write(PROMPTS_KEY, refine || summarize ? { refine, summarize } : null);
}
