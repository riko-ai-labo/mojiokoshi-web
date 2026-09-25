/**
 * Googleログイン（Google Identity Services トークンクライアント）
 * スコープは drive.file（このアプリが作ったファイルのみ）＋プロフィール表示用の非センシティブなものだけ。
 */

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
  'profile',
].join(' ');

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

/** GISライブラリの読み込み完了を待つ */
function waitForGis(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('Googleログイン機能の読み込みに失敗しました。ページを再読み込みしてください'));
      }
      setTimeout(check, 100);
    })();
  });
}

export async function initAuth(clientId) {
  await waitForGis();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: () => {}, // requestToken内で毎回差し替える
  });
}

/**
 * アクセストークンを取得する。
 * prompt: '' なら同意済みユーザーはポップアップが自動で閉じる（実質サイレント）
 */
export function requestToken(prompt = '') {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error('ログイン機能が初期化されていません'));
    tokenClient.callback = (resp) => {
      if (resp.error) {
        return reject(new Error('ログインに失敗しました: ' + resp.error));
      }
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      resolve(accessToken);
    };
    tokenClient.error_callback = (err) => {
      reject(new Error('ログインがキャンセルされました' + (err?.type ? `（${err.type}）` : '')));
    };
    tokenClient.requestAccessToken({ prompt });
  });
}

export function hasValidToken() {
  return !!accessToken && Date.now() < tokenExpiresAt - 60 * 1000;
}

/**
 * 有効なトークンを返す。期限切れならサイレント再取得を試みる。
 * （長時間の文字起こし後の保存時に期限切れになっているケース用。
 *   保存ボタンのクリック＝ユーザー操作の中で呼ばれる想定）
 */
export async function ensureToken() {
  if (hasValidToken()) return accessToken;
  return requestToken('');
}

export async function getUserInfo() {
  const token = await ensureToken();
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('ユーザー情報の取得に失敗しました');
  return res.json(); // { name, email, picture, ... }
}
