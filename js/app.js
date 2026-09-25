/**
 * 文字起こしするちゃん Drive版 v2 - メインアプリ
 *
 * 流れ: ライセンスキー入力（サーバー側で照合） → ファイル選択（ブラウザ内で解析）
 *   → 音声を15分ずつ切り出してGeminiへ送り、順に文字起こし（次のチャンクは先にアップロードしておく）
 *   → タイムスタンプと本文で重複を除いて結合 → 辞書適用 → 整形・要約
 *   → 結果編集 → コピー・txt保存 ／ 本人のDriveへ保存（このときだけGoogleログイン） ／ 修正差分から辞書学習
 *
 * 切り出せない形式（WebMなど）は、ファイル全体を1回アップロードして範囲指定で文字起こしする。
 * 途中経過は localStorage に保存し、失敗やタブ閉じの後も同じファイルなら続きから再開する。
 */

import { initAuth, ensureToken } from './google-auth.js';
import { gasCall } from './gas-client.js';
import { getLicenseKey, setLicenseKey, clearLicenseKey } from './license.js';
import { uploadBlob, waitForActive, getMimeType, isVideoMime, SUPPORTED_EXTENSIONS } from './upload.js';
import { analyzeMedia, planChunks } from './media-split.js';
import { parseLines, absolutizeLines, mergeChunks, serializeLines } from './merge.js';
import { applyDictionary, suggestCorrections } from './dictionary.js';
import { saveToDrive } from './drive-save.js';
import {
  fileKey, loadJob, saveJob, clearJob, loadResult, saveResult, clearResult, loadHint, saveHint,
} from './storage.js';

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // Gemini Files APIの上限
const CHUNK_SEC = 15 * 60; // 15分ごとに文字起こし
const OVERLAP_SEC = 30; // 前後ののりしろ（境界の取りこぼし防止）
const UPLOAD_AHEAD = 2; // 文字起こし中に先行してアップロードしておくチャンク数
const REFINE_CHUNK_CHARS = 6000; // 整形は文字数で分割

const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  media: null, // analyzeMedia の結果（切り出し可能なとき）
  wholeMime: null, // 丸ごと送る場合のMIME
  duration: null,
  dict: [],
  resultFileName: '',
  originalTranscript: '',
  originalRefined: '',
  busy: false,
  wakeLock: null,
  startedAt: 0,
  driveReady: null, // Googleログイン機能の初期化Promise（OAUTH_CLIENT_ID があるときだけ）
};

// ================================================================ 初期化

window.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  $('optHint').value = loadHint();

  const { GAS_URL, OAUTH_CLIENT_ID } = window.APP_CONFIG || {};
  if (!GAS_URL) {
    show('setupWarning');
    return;
  }
  // Drive保存は任意機能。クライアントIDがあるときだけボタンを出し、ログインは保存を押したときに初めて求める
  if (OAUTH_CLIENT_ID) {
    state.driveReady = initAuth(OAUTH_CLIENT_ID);
    state.driveReady.catch(() => {}); // 失敗は保存ボタンを押したときに表示する
    show('btnSave');
    show('saveHelp');
  }
  // 別の操作中にキーが無効（停止・期限切れ）と判定されたら入口へ戻す
  window.addEventListener('license-invalid', (e) => lockOut(e.detail?.message));

  if (getLicenseKey()) {
    show('licenseChecking');
    await enterWithKey(getLicenseKey(), true);
  } else {
    showLicenseForm();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!state.busy) return;
  e.preventDefault();
  e.returnValue = '';
});

document.addEventListener('visibilitychange', () => {
  if (state.busy && document.visibilityState === 'visible') keepAwake();
});

function bindEvents() {
  $('licenseForm').addEventListener('submit', (e) => {
    e.preventDefault();
    enterWithKey($('licenseInput').value, false);
  });
  $('btnLogout').addEventListener('click', () => {
    if (state.busy) return;
    clearLicenseKey();
    lockOut('');
  });

  $('navMain').addEventListener('click', () => switchPage('main'));
  $('navDict').addEventListener('click', () => switchPage('dict'));

  const dropZone = $('dropZone');
  const fileInput = $('fileInput');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setFile(fileInput.files[0]);
  });
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  $('btnStart').addEventListener('click', run);
  $('btnDiscardJob').addEventListener('click', () => {
    clearJob();
    updateResumeNote();
  });
  $('btnRestoreResult').addEventListener('click', restoreLastResult);

  $('btnTabTranscript').addEventListener('click', () => switchResultTab('transcript'));
  $('btnTabSummary').addEventListener('click', () => switchResultTab('summary'));

  $('btnSave').addEventListener('click', save);
  $('btnCopy').addEventListener('click', copyCurrent);
  $('btnDownload').addEventListener('click', downloadCurrent);
  $('btnLearn').addEventListener('click', openLearnPanel);
  $('btnLearnApply').addEventListener('click', applyLearn);
  $('btnLearnCancel').addEventListener('click', () => hide('learnPanel'));

  $('btnDictReload').addEventListener('click', loadDictPage);
  $('btnDictAddRow').addEventListener('click', () => addDictRow({ surface: '', reading: '', wrongs: [] }));
  $('btnDictSave').addEventListener('click', saveDictPage);
}

// ================================================================ 小物

function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }

function showError(message) {
  const el = $('errorBox');
  el.textContent = '⚠ ' + message;
  el.hidden = false;
  el.scrollIntoView({ block: 'nearest' });
}
function clearError() { $('errorBox').hidden = true; }

function setNotice(message) {
  const el = $('resultNotice');
  el.textContent = message;
  el.hidden = !message;
}

function setProgress(percent, message, detail = '') {
  show('progressSection');
  $('progressFill').style.width = Math.round(Math.min(100, percent)) + '%';
  $('progressMsg').textContent = message;
  $('progressDetail').textContent = detail;
}

function setEta(remainingSec) {
  const el = $('progressEta');
  if (remainingSec == null) {
    el.textContent = '';
    return;
  }
  const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
  el.textContent = `経過 ${fmtClock(elapsed)} ／ 残り目安 ${remainingSec < 60 ? '1分未満' : '約' + Math.ceil(remainingSec / 60) + '分'}`;
}

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return sec >= 3600
    ? `${Math.floor(sec / 3600)}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`
    : `${Math.floor(sec / 60)}:${p(sec % 60)}`;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}

function fmtSize(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function baseName(name) {
  return String(name || 'transcript').replace(/\.[^.]+$/, '');
}

/** ブラウザの <audio>/<video> でメタデータから長さを取る（切り出せない形式のフォールバック用） */
function getMediaDuration(file, isVideo) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(isVideo ? 'video' : 'audio');
    el.preload = 'metadata';
    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}

async function keepAwake() {
  try {
    if (navigator.wakeLock && (!state.wakeLock || state.wakeLock.released)) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch { /* 非対応・拒否は無視 */ }
}

function releaseWake() {
  try {
    state.wakeLock?.release();
  } catch { /* ignore */ }
  state.wakeLock = null;
}

// ================================================================ ライセンスキー

function showLicenseForm(message = '') {
  hide('licenseChecking');
  const msg = $('licenseMsg');
  msg.textContent = message;
  msg.hidden = !message;
  show('licenseSection');
  $('licenseInput').focus();
}

/** キーをサーバーで照合し、通れば本体を開く。silent=true は起動時の自動確認 */
async function enterWithKey(rawKey, silent) {
  clearError();
  const previous = getLicenseKey();
  setLicenseKey(rawKey);
  if (!getLicenseKey()) {
    showLicenseForm('ライセンスキーを入力してください');
    return;
  }
  $('btnLicense').disabled = true;
  $('btnLicense').textContent = '確認中...';
  try {
    const info = await gasCall('licenseCheck');
    hide('licenseSection');
    hide('licenseChecking');
    $('userChipText').textContent = info.name ? `${info.name} さん` : 'ライセンス認証済み';
    if (info.expires) $('userChipText').textContent += `（${info.expires}まで）`;
    show('userChip');
    show('mainSection');
    show('pageNav');
    updateRestoreBox();
  } catch (err) {
    if (err.code) {
      // キーそのものが通らなかった → 記憶を消して入力画面へ（lockOut は license-invalid イベント側でも走る）
      clearLicenseKey();
      showLicenseForm(err.message);
    } else {
      // 通信エラー等。記憶済みのキーは消さない
      setLicenseKey(silent ? previous : '');
      showLicenseForm('確認できませんでした。通信状況を確かめて、もう一度お試しください（' + err.message + '）');
      if (silent) $('licenseInput').value = previous;
    }
  } finally {
    $('btnLicense').disabled = false;
    $('btnLicense').textContent = 'はじめる';
  }
}

/** 本体を閉じて入口へ戻す（キーの停止・期限切れ・「キーを変更」） */
function lockOut(message) {
  clearLicenseKey();
  switchPage('main');
  ['mainSection', 'pageNav', 'userChip', 'progressSection', 'resultSection'].forEach(hide);
  $('licenseInput').value = '';
  showLicenseForm(message || '');
}

// ================================================================ ファイル選択

async function setFile(file) {
  clearError();
  const mimeType = getMimeType(file.name);
  if (!mimeType) {
    showError(`対応形式は ${SUPPORTED_EXTENSIONS.map((e) => e.toUpperCase()).join(' / ')} です`);
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showError(`ファイルが大きすぎます（上限2GB、選択: ${fmtSize(file.size)}）。動画編集ソフト等で圧縮してからお試しください`);
    return;
  }
  state.file = file;
  state.wholeMime = mimeType;
  state.media = null;
  state.duration = null;
  $('fileInfo').innerHTML = `<b>${escapeHtml(file.name)}</b><br>解析中...`;
  show('fileInfo');
  $('btnStart').disabled = true;

  // ブラウザ内で音声トラックを解析（できれば音声だけを切り出して送る）
  const media = await analyzeMedia(file);
  if (state.file !== file) return; // 解析中に別ファイルが選ばれた
  let modeText;
  if (media) {
    state.media = media;
    state.duration = media.duration;
    modeText = `音声だけを抜き出して送ります（送信量 約${fmtSize(media.audioBytes)}）`;
  } else {
    state.duration = await getMediaDuration(file, isVideoMime(mimeType));
    modeText = 'ファイル全体を送って範囲指定で処理します';
  }
  const isVideo = isVideoMime(mimeType);
  $('optTimestamps').checked = isVideo;

  const durText = state.duration != null ? fmtTime(state.duration) : '不明（長さを取得できませんでした）';
  $('fileInfo').innerHTML =
    `<b>${escapeHtml(file.name)}</b><br>サイズ: ${fmtSize(file.size)} ／ 長さ: ${durText}<br>` +
    `<span class="muted small">${modeText}</span>`;
  show('optionsRow');
  $('btnStart').disabled = false;
  updateResumeNote();
}

/** 同じファイルの途中結果が残っていれば案内を出す */
function updateResumeNote() {
  const job = state.file && loadJob();
  const el = $('resumeNote');
  if (!job || job.fileKey !== fileKey(state.file)) {
    el.hidden = true;
    return;
  }
  const done = Object.keys(job.chunkTexts || {}).length;
  $('resumeNoteText').textContent =
    `このファイルは前回 ${done}/${job.totalChunks} 区間まで処理済みです。開始すると続きから再開します。`;
  el.hidden = false;
}

function updateRestoreBox() {
  const last = loadResult();
  if (!last) {
    hide('restoreBox');
    return;
  }
  $('restoreText').textContent = `前回の結果: ${last.fileName}（${new Date(last.savedAt).toLocaleString('ja-JP')}）`;
  show('restoreBox');
}

function restoreLastResult() {
  const last = loadResult();
  if (!last) return;
  showResult({
    fileName: last.fileName,
    transcript: last.transcript,
    refined: last.refined,
    summary: last.summary,
  });
  setNotice('前回の結果を復元しました（保存や辞書学習もできます）');
}

// ================================================================ 文字起こし本体

function currentOptions() {
  return {
    withTimestamps: $('optTimestamps').checked,
    speakers: $('optSpeakers').checked,
    hint: $('optHint').value.trim(),
  };
}

/** 途中結果の読み込み（同じファイル・同じ文字起こし条件のときだけ再利用） */
function loadResumableJob(file, options, totalChunks) {
  const job = loadJob();
  if (!job || job.fileKey !== fileKey(file)) return null;
  if (job.totalChunks !== totalChunks || job.speakers !== options.speakers || job.hint !== options.hint) return null;
  return job;
}

function splitForRefine(text) {
  const blocks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > REFINE_CHUNK_CHARS) {
      blocks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current.trim()) blocks.push(current);
  return blocks.length ? blocks : [text];
}

async function run() {
  if (state.busy || !state.file) return;
  state.busy = true;
  state.startedAt = Date.now();
  $('btnStart').disabled = true;
  clearError();
  setNotice('');
  hide('resultSection');
  hide('savedBox');
  hide('resumeNote');
  keepAwake();

  const options = currentOptions();
  saveHint(options.hint);
  const file = state.file;
  const geminiFiles = new Set(); // 後始末用
  const notices = [];

  try {
    try {
      state.dict = (await gasCall('dictGet')).entries || [];
    } catch {
      state.dict = [];
    }

    // ---- 文字起こし（チャンクごと）
    const chunkResults = state.media
      ? await transcribeSliced(file, state.media, options, geminiFiles, notices)
      : await transcribeWhole(file, options, geminiFiles, notices);

    // ---- 結合 → 辞書 → 整形 → 要約
    setProgress(80, '区間をつなぎ合わせています...');
    const merged = mergeChunks(chunkResults);
    let transcript = serializeLines(merged, options.withTimestamps);
    transcript = applyDictionary(transcript, state.dict);
    if (!transcript.trim()) throw new Error('文字起こし結果が空でした。音声が入っているファイルか確認してください');

    const blocks = splitForRefine(transcript);
    const refinedParts = [];
    for (let i = 0; i < blocks.length; i++) {
      setProgress(80 + (i / blocks.length) * 12,
        blocks.length > 1 ? `テキストを整形中... (${i + 1}/${blocks.length})` : 'テキストを整形中...');
      setEta(estimateTextPhase(blocks.length - i, 1));
      const { text } = await gasCall('refine', {
        text: blocks[i],
        chunkIndex: i,
        totalChunks: blocks.length,
        prevTail: refinedParts.length ? refinedParts[refinedParts.length - 1].slice(-400) : '',
      });
      refinedParts.push(text.trim());
    }
    const refined = applyDictionary(refinedParts.join('\n\n'), state.dict);

    setProgress(93, '要約を作成中...');
    setEta(estimateTextPhase(0, 1));
    const { text: summary } = await gasCall('summarize', { text: transcript, hint: options.hint });

    setProgress(100, '完了しました！');
    setEta(null);
    clearJob();

    const result = { fileName: file.name, transcript, refined, summary: summary.trim(), savedAt: Date.now() };
    saveResult(result);
    updateRestoreBox();
    showResult(result);
    setNotice(notices.join(' ／ '));
  } catch (err) {
    showError(err.message + '\n（同じファイルをもう一度開始すると、終わった区間は飛ばして続きから再開します）');
    hide('progressSection');
  } finally {
    if (geminiFiles.size) gasCall('deleteFile', { geminiFileNames: [...geminiFiles] }).catch(() => {});
    releaseWake();
    state.busy = false;
    $('btnStart').disabled = false;
    updateResumeNote();
  }
}

/** 整形・要約フェーズの残り時間の目安（秒） */
function estimateTextPhase(refineRemaining, summaryRemaining) {
  return refineRemaining * 25 + summaryRemaining * 30;
}

/** 音声を切り出して送るモード。次のチャンクのアップロードを先行させる */
async function transcribeSliced(file, media, options, geminiFiles, notices) {
  const chunks = planChunks(media.duration, CHUNK_SEC, OVERLAP_SEC);
  const n = chunks.length;
  const job = loadResumableJob(file, options, n) || {
    fileKey: fileKey(file), fileName: file.name, totalChunks: n,
    speakers: options.speakers, hint: options.hint, chunkTexts: {}, createdAt: Date.now(),
  };
  const base = baseName(file.name);

  // アップロードは先行して最大 UPLOAD_AHEAD 件まで並行
  const uploads = new Array(n);
  let next = 0;
  let inflight = 0;
  const pump = () => {
    while (inflight < UPLOAD_AHEAD && next < n) {
      const i = next++;
      if (job.chunkTexts[i] != null) {
        uploads[i] = Promise.resolve(null);
        continue;
      }
      inflight++;
      uploads[i] = (async () => {
        const c = chunks[i];
        const blob = await media.slice(c.audioStart, c.audioEnd);
        const gf = await uploadBlob(blob, media.mimeType, `${base}-part${i + 1}.${media.ext}`, (ratio) => {
          if (i === currentIndex) setProgress(progressFor(i, ratio * 0.3), labelFor(i, 'アップロード中'), `${Math.round(ratio * 100)}%`);
        });
        geminiFiles.add(gf.name);
        const ready = await waitForActive(gf.name);
        return ready;
      })().finally(() => {
        inflight--;
        pump();
      });
      // 先行アップロードの失敗は、その区間を await した時点で拾う（それまでの未処理警告を抑える）
      uploads[i].catch(() => {});
    }
  };

  let currentIndex = 0;
  const chunkTimes = [];
  const labelFor = (i, what) => (n > 1 ? `${what}... (${i + 1}/${n})` : `${what}...`);
  const progressFor = (i, within) => 5 + ((i + within) / n) * 75;
  const rangeText = (c) => `${fmtTime(c.nominalStart)}〜${fmtTime(c.nominalEnd)}`;

  pump();
  const results = [];
  for (let i = 0; i < n; i++) {
    currentIndex = i;
    const c = chunks[i];
    const t0 = Date.now();
    setEta(estimateRemaining(chunkTimes, n - i, c));
    let text = job.chunkTexts[i];
    if (text == null) {
      setProgress(progressFor(i, 0), labelFor(i, 'アップロード中'), rangeText(c));
      const ready = await uploads[i];
      setProgress(progressFor(i, 0.3), labelFor(i, '文字起こし中'), rangeText(c));
      const prev = results.length ? serializeLines(results[results.length - 1].lines).slice(-600) : '';
      const res = await gasCall('transcribe', {
        fileUri: ready.uri,
        mimeType: ready.mimeType,
        mode: 'chunk',
        audioStart: c.audioStart,
        audioEnd: c.audioEnd,
        isVideo: false,
        speakers: options.speakers,
        hint: options.hint,
        prevTail: prev,
      });
      text = res.text;
      if (res.truncated) notices.push(`区間${i + 1}（${rangeText(c)}）の出力が上限で途切れた可能性があります`);
      job.chunkTexts[i] = text;
      saveJob(job);
      gasCall('deleteFile', { geminiFileName: ready.name }).catch(() => {});
      geminiFiles.delete(ready.name);
      chunkTimes.push((Date.now() - t0) / 1000);
    } else {
      setProgress(progressFor(i, 1), labelFor(i, '前回の結果を再利用'), rangeText(c));
    }
    const lines = absolutizeLines(parseLines(text), c.audioStart, c.audioEnd - c.audioStart, true);
    results.push({ nominalStart: c.nominalStart, lines });
  }
  return results;
}

/** 切り出せない形式: ファイル全体を1回アップロードし、範囲指定で文字起こし */
async function transcribeWhole(file, options, geminiFiles, notices) {
  const isVideo = isVideoMime(state.wholeMime);
  notices.push('この形式は音声だけの切り出しに対応していないため、ファイル全体を送って処理しました');

  setProgress(2, 'ファイルをアップロード中...', '');
  const gf = await uploadBlob(file, state.wholeMime, file.name, (ratio) => {
    setProgress(2 + ratio * 25, 'ファイルをアップロード中...', `${Math.round(ratio * 100)}%`);
  });
  geminiFiles.add(gf.name);
  setProgress(28, 'ファイルを処理中...', isVideo ? '動画は数分かかることがあります' : '');
  const ready = await waitForActive(gf.name, (sec) => setProgress(28, 'ファイルを処理中...', `${sec}秒経過`));

  let duration = state.duration;
  if (duration == null && ready.videoDuration) {
    const m = String(ready.videoDuration).match(/^([\d.]+)s$/);
    if (m) duration = Number(m[1]);
  }
  if (duration == null) {
    notices.push('長さを取得できなかったため一括で処理しました（長時間ファイルは途中で切れることがあります）');
  }
  const chunks = planChunks(duration || 0, CHUNK_SEC, OVERLAP_SEC);
  const n = chunks.length;
  const job = loadResumableJob(file, options, n) || {
    fileKey: fileKey(file), fileName: file.name, totalChunks: n,
    speakers: options.speakers, hint: options.hint, chunkTexts: {}, createdAt: Date.now(),
  };
  const chunkTimes = [];
  const results = [];
  for (let i = 0; i < n; i++) {
    const c = chunks[i];
    const t0 = Date.now();
    const label = n > 1 ? `文字起こし中... (${i + 1}/${n})` : '文字起こし中...';
    const detail = n > 1 ? `${fmtTime(c.nominalStart)}〜${fmtTime(c.nominalEnd)}` : '';
    setProgress(30 + (i / n) * 50, label, detail);
    setEta(estimateRemaining(chunkTimes, n - i, c));
    let text = job.chunkTexts[i];
    if (text == null) {
      const prev = results.length ? serializeLines(results[results.length - 1].lines).slice(-600) : '';
      const res = await gasCall('transcribe', {
        fileUri: ready.uri,
        mimeType: ready.mimeType,
        mode: 'whole',
        audioStart: c.audioStart,
        audioEnd: c.audioEnd || duration || 0,
        isVideo,
        speakers: options.speakers,
        hint: options.hint,
        prevTail: prev,
      });
      text = res.text;
      if (res.truncated) notices.push(`区間${i + 1}の出力が上限で途切れた可能性があります`);
      job.chunkTexts[i] = text;
      saveJob(job);
      chunkTimes.push((Date.now() - t0) / 1000);
    }
    const lines = absolutizeLines(parseLines(text), c.audioStart, c.audioEnd - c.audioStart, false);
    results.push({ nominalStart: c.nominalStart, lines });
  }
  return results;
}

/** チャンクの平均処理時間から残り時間を見積もる（秒） */
function estimateRemaining(chunkTimes, remainingChunks, chunk) {
  const per = chunkTimes.length
    ? chunkTimes.reduce((a, b) => a + b, 0) / chunkTimes.length
    : Math.max(30, ((chunk.audioEnd - chunk.audioStart) / 60) * 4); // 初回は「1分の音声≒4秒」で仮置き
  return per * remainingChunks + estimateTextPhase(2, 1);
}

// ================================================================ 結果表示・保存

function showResult({ fileName, transcript, refined, summary }) {
  state.resultFileName = fileName;
  state.originalTranscript = transcript;
  state.originalRefined = refined;
  $('transcriptArea').value = transcript;
  $('refinedArea').value = refined;
  $('summaryArea').value = summary;
  hide('progressSection');
  hide('learnPanel');
  hide('savedBox');
  show('resultSection');
  switchResultTab('transcript');
  $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function switchResultTab(tab) {
  const isTranscript = tab === 'transcript';
  $('btnTabTranscript').classList.toggle('active', isTranscript);
  $('btnTabSummary').classList.toggle('active', !isTranscript);
  $('tabTranscript').hidden = !isTranscript;
  $('tabSummary').hidden = isTranscript;
}

function currentTabText() {
  if (!$('tabTranscript').hidden) return $('transcriptArea').value;
  return '■ 要約\n' + $('summaryArea').value + '\n\n■ 整形テキスト\n' + $('refinedArea').value;
}

async function copyCurrent() {
  try {
    await navigator.clipboard.writeText(currentTabText());
    flashStatus('コピーしました');
  } catch {
    showError('コピーできませんでした。テキストを選択して手動でコピーしてください');
  }
}

function downloadCurrent() {
  const isTranscript = !$('tabTranscript').hidden;
  const name = `${dateStamp()}-${baseName(state.resultFileName)}-${isTranscript ? '文字起こし' : '要約整形'}.txt`;
  const blob = new Blob([currentTabText()], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function flashStatus(msg) {
  const el = $('resultStatus');
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
}

async function save() {
  if (state.busy) return;
  state.busy = true;
  $('btnSave').disabled = true;
  clearError();
  try {
    flashStatus('Googleにログインして保存します...');
    await state.driveReady; // Googleログイン機能の読み込み完了待ち（失敗していればここでエラー表示）
    const token = await ensureToken(); // 未ログインならここでGoogleのログイン画面が開く
    flashStatus('Googleドライブに保存中...');
    const { url } = await saveToDrive(token, {
      title: `${dateStamp()}_${baseName(state.resultFileName)}_文字起こし`,
      transcriptText: $('transcriptArea').value,
      refinedText: $('refinedArea').value,
      summaryText: $('summaryArea').value,
    });
    $('savedLink').href = url;
    show('savedBox');
    flashStatus('');
  } catch (err) {
    showError('保存に失敗しました: ' + err.message);
  } finally {
    state.busy = false;
    $('btnSave').disabled = false;
  }
}

// ================================================================ 辞書学習（修正差分から）

let learnPairs = [];

function openLearnPanel() {
  clearError();
  const pairs = [
    ...suggestCorrections(state.originalTranscript, $('transcriptArea').value),
    ...suggestCorrections(state.originalRefined, $('refinedArea').value),
  ];
  const seen = new Set();
  learnPairs = pairs.filter((p) => {
    const key = p.wrong + ' ' + p.correct;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const list = $('learnList');
  list.innerHTML = '';
  if (!learnPairs.length) {
    list.innerHTML = '<p class="muted">修正が見つかりませんでした。テキストを直してからもう一度押してください。</p>';
    $('btnLearnApply').disabled = true;
  } else {
    learnPairs.forEach((p, i) => {
      const label = document.createElement('label');
      label.className = 'learn-item';
      label.innerHTML =
        `<input type="checkbox" checked data-index="${i}"> ` +
        `「${escapeHtml(p.wrong)}」→「${escapeHtml(p.correct)}」`;
      list.appendChild(label);
    });
    $('btnLearnApply').disabled = false;
  }
  show('learnPanel');
}

async function applyLearn() {
  const checked = [...$('learnList').querySelectorAll('input:checked')]
    .map((el) => learnPairs[Number(el.dataset.index)]);
  if (!checked.length) {
    hide('learnPanel');
    return;
  }
  $('btnLearnApply').disabled = true;
  try {
    const result = await gasCall('dictAdd', {
      entries: checked.map((p) => ({ surface: p.correct, reading: '', wrongs: [p.wrong] })),
    });
    state.dict = result.entries || state.dict;
    $('transcriptArea').value = applyDictionary($('transcriptArea').value, state.dict);
    $('refinedArea').value = applyDictionary($('refinedArea').value, state.dict);
    state.originalTranscript = $('transcriptArea').value;
    state.originalRefined = $('refinedArea').value;
    hide('learnPanel');
    flashStatus(`辞書に${checked.length}件登録しました（チーム全員に反映されます）`);
  } catch (err) {
    showError('辞書登録に失敗しました: ' + err.message);
  } finally {
    $('btnLearnApply').disabled = false;
  }
}

// ================================================================ 辞書管理ページ

function switchPage(page) {
  const isMain = page === 'main';
  $('navMain').classList.toggle('active', isMain);
  $('navDict').classList.toggle('active', !isMain);
  $('pageMain').hidden = !isMain;
  $('pageDict').hidden = isMain;
  if (!isMain) loadDictPage();
}

async function loadDictPage() {
  const status = $('dictStatus');
  status.textContent = '読み込み中...';
  try {
    const { entries } = await gasCall('dictGet');
    const tbody = $('dictBody');
    tbody.innerHTML = '';
    entries.forEach((e) => addDictRow(e));
    status.textContent = entries.length ? `${entries.length}件` : 'まだ登録がありません';
  } catch (err) {
    status.textContent = '読み込みに失敗しました: ' + err.message;
  }
}

function addDictRow(entry) {
  const tbody = $('dictBody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="d-surface" placeholder="正しい表記"></td>
    <td><input type="text" class="d-reading" placeholder="読み（ひらがな）"></td>
    <td><input type="text" class="d-wrongs" placeholder="誤認識例1|誤認識例2"></td>
    <td><button type="button" class="btn-mini d-remove">削除</button></td>`;
  tr.querySelector('.d-surface').value = entry.surface || '';
  tr.querySelector('.d-reading').value = entry.reading || '';
  tr.querySelector('.d-wrongs').value = (entry.wrongs || []).join('|');
  tr.querySelector('.d-remove').addEventListener('click', () => tr.remove());
  tbody.appendChild(tr);
}

async function saveDictPage() {
  const status = $('dictStatus');
  const entries = [...$('dictBody').querySelectorAll('tr')].map((tr) => ({
    surface: tr.querySelector('.d-surface').value.trim(),
    reading: tr.querySelector('.d-reading').value.trim(),
    wrongs: tr.querySelector('.d-wrongs').value.split('|').map((w) => w.trim()).filter(Boolean),
  })).filter((e) => e.surface);
  $('btnDictSave').disabled = true;
  status.textContent = '保存中...';
  try {
    const result = await gasCall('dictUpdate', { entries });
    state.dict = result.entries || entries;
    status.textContent = `保存しました（${entries.length}件・チーム全員に反映されます）`;
  } catch (err) {
    status.textContent = '保存に失敗しました: ' + err.message;
  } finally {
    $('btnDictSave').disabled = false;
  }
}
