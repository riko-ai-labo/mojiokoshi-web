/**
 * Gemini Files API への直接アップロード
 * GASが発行したアップロードURL（APIキー不要）へ、File/Blobをそのまま送る。
 * base64を経由しないため、Files APIの上限（2GB）までメモリを圧迫せずに扱える。
 */

import { gasCall } from './gas-client.js';

/** ファイル丸ごと送る場合のMIME（Geminiのサポート表記に合わせる） */
const WHOLE_FILE_MIME = {
  mp3: 'audio/mp3',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mov', // Mac QuickTime録画・iPhoneの動画
  webm: 'video/webm',
};

export const SUPPORTED_EXTENSIONS = Object.keys(WHOLE_FILE_MIME);

export function getMimeType(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  return WHOLE_FILE_MIME[ext] || null;
}

export function isVideoMime(mimeType) {
  return String(mimeType).startsWith('video/');
}

/**
 * アップロード実行。onProgress(0〜1) で進捗を通知。
 * 戻り値: Gemini Files APIのfileオブジェクト { name, uri, mimeType, state, ... }
 */
export async function uploadBlob(blob, mimeType, displayName, onProgress) {
  const { uploadUrl } = await gasCall('startUpload', {
    fileName: displayName,
    fileSize: blob.size,
    mimeType,
  });

  const result = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
    xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('アップロード結果の解析に失敗しました'));
        }
      } else {
        reject(new Error(`ファイルアップロードに失敗しました (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('アップロード中にネットワークエラーが発生しました'));
    xhr.send(blob);
  });

  return result.file;
}

/** Gemini側のファイル処理がACTIVEになるまで待つ（音声は数秒、動画は数分かかることがある） */
export async function waitForActive(geminiFileName, onTick) {
  const maxWaitMs = 10 * 60 * 1000;
  const started = Date.now();
  let interval = 1500;
  for (let i = 0; Date.now() - started < maxWaitMs; i++) {
    const status = await gasCall('fileStatus', { geminiFileName });
    if (status.state === 'ACTIVE') return status;
    if (status.state === 'FAILED') {
      throw new Error('Gemini側でのファイル処理に失敗しました' + (status.error ? `: ${status.error}` : ''));
    }
    onTick?.(Math.round((Date.now() - started) / 1000));
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(5000, interval + 500);
  }
  throw new Error('ファイル処理がタイムアウトしました');
}
