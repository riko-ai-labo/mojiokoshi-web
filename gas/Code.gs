/**
 * 文字起こしするちゃん Drive版 v2 - Google Apps Script バックエンド
 *
 * 役割: Gemini APIキーをサーバー側に隠したまま、
 *   ① Files APIのアップロードURL発行  ② 文字起こし／整形／要約  ③ チーム共有辞書の読み書き
 * を行う。ファイル本体はここを通らず、ブラウザ→Gemini直送（startUploadで発行したURLへPUT）。
 *
 * v2の変更点:
 *   - ブラウザ側で音声を15分ずつ切り出して送る方式に対応（mode: 'chunk'）。
 *     ファイル全体を毎回渡していた v1 と違い、1時間超の動画でも上限に当たらず、コストも大幅減。
 *   - 切り出せない形式向けに、ファイル全体＋範囲指定のフォールバック（mode: 'whole'）。
 *     動画は videoMetadata で区間をAPI側に切らせ、低解像度（音声だけ必要）で処理。
 *   - 文字起こしは低temperature・思考オフ・安全フィルタ緩和・出力上限明示で、幻覚と途中切れを抑制。
 *   - 「内容のヒント」（講座名・登場人物・専門用語）をプロンプトに注入。
 *   - GETでセットアップ診断（キー／辞書シート／モデルの設定状況）を返す。
 *
 * 【セットアップ手順】docs/SETUP.md 参照
 *   スクリプト プロパティ:
 *     GEMINI_API_KEY : Gemini APIキー（必須）
 *     DICT_SHEET_ID  : チーム共有辞書スプレッドシートのID（必須）
 *     MODEL          : 使用モデル（省略時 gemini-2.5-flash）
 *     LICENSE_SHEET_ID : （任意）ライセンス台帳を別のスプレッドシートに置く場合のID
 *
 * v2.1: ライセンスキー認証を追加。
 *   - すべての操作（doPost）でライセンスキーをサーバー側で照合する。無効なキーでは何も動かない。
 *   - 台帳は辞書と同じスプレッドシートの「ライセンス」タブ（無ければ自動作成）。
 *     B列に名前を書いてからエディタで issueLicenseKeys を実行すると、キーが自動で発行される。
 *   - 状態を「停止」にするか期限を過ぎると、数分以内に使えなくなる。
 *   - 文字起こしの利用分数を人ごと・月ごとに集計し、「月の上限(分)」を超えたら止める。
 */

var VERSION = '2.2.0';
var DEFAULT_MODEL = 'gemini-2.5-flash';
var GEMINI_BASE = 'https://generativelanguage.googleapis.com';

function props_() {
  return PropertiesService.getScriptProperties();
}

function cfg_(key, def) {
  return props_().getProperty(key) || def || '';
}

function apiKey_() {
  var key = cfg_('GEMINI_API_KEY');
  if (!key) throw new Error('スクリプトプロパティ GEMINI_API_KEY が設定されていません');
  return key;
}

function model_() {
  return cfg_('MODEL', DEFAULT_MODEL);
}

// ================================================================ エントリポイント

/** ブラウザでURLを開くと設定状況が見える（値そのものは出さない） */
function doGet(e) {
  var dictOk = false;
  var dictError = '';
  try {
    if (cfg_('DICT_SHEET_ID')) {
      SpreadsheetApp.openById(cfg_('DICT_SHEET_ID')).getSheets()[0];
      dictOk = true;
    }
  } catch (err) {
    dictError = err.message;
  }
  return json_({
    success: true,
    message: '文字起こしするちゃん Drive版 GAS API is running',
    version: VERSION,
    config: {
      GEMINI_API_KEY: cfg_('GEMINI_API_KEY') ? '設定済み' : '未設定',
      DICT_SHEET_ID: !cfg_('DICT_SHEET_ID') ? '未設定' : dictOk ? '設定済み（開けました）' : '開けません: ' + dictError,
      MODEL: model_(),
      LICENSE: licenseDiag_()
    }
  });
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var handlers = {
      ping: function () { return { pong: true, version: VERSION, model: model_() }; },
      licenseCheck: function (d, lic) { return licensePublic_(lic); },
      startUpload: startUpload,
      fileStatus: fileStatus,
      uploadResult: uploadResult,
      deleteFile: deleteFile,
      transcribe: transcribe,
      refine: refine,
      summarize: summarize,
      promptDefaults: promptDefaults,
      dictGet: dictGet,
      dictAdd: dictAdd,
      dictUpdate: dictUpdate
    };
    var handler = handlers[data.action];
    if (!handler) return json_({ success: false, message: '不明なaction: ' + data.action });

    // ---- ライセンス照合（ping以外のすべての操作で必須。ここを通らないと何も実行されない）
    var lic = null;
    if (data.action !== 'ping') {
      lic = verifyLicense_(data.licenseKey);
      if (data.action === 'transcribe') checkUsageLimit_(lic, data); // 上限超えは実行前に止める
    }
    var result = handler(data, lic);
    if (lic) {
      // 利用の記録は成功後（失敗→再試行で二重に数えないため）
      if (data.action === 'transcribe') addUsage_(lic, data);
      if (data.action === 'dictAdd' || data.action === 'dictUpdate') logUsage_(lic, data.action, 0);
    }
    return json_({ success: true, message: 'OK', data: result });
  } catch (err) {
    return json_({ success: false, code: err.licenseCode || '', message: err.message });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================================================================ Gemini API 共通

/** 429/5xx をバックオフ付きでリトライする共通フェッチ */
function fetchWithRetry_(url, options, maxRetries) {
  maxRetries = maxRetries || 4;
  var merged = { muteHttpExceptions: true };
  for (var k in options) merged[k] = options[k];
  for (var attempt = 1; ; attempt++) {
    var res = UrlFetchApp.fetch(url, merged);
    var code = res.getResponseCode();
    if (code < 400) return res;
    var retriable = code === 429 || code >= 500;
    if (!retriable || attempt >= maxRetries) {
      throw new Error('Gemini APIエラー (' + code + '): ' + res.getContentText().slice(0, 500));
    }
    Utilities.sleep(5000 * attempt);
  }
}

/**
 * resumableアップロードの開始のみを行い、アップロードURLをブラウザへ返す。
 * ファイル本体はブラウザがこのURLへ直接送るため、APIキーはクライアントに渡らない。
 */
function startUpload(d) {
  if (!d.fileName || !d.fileSize || !d.mimeType) {
    throw new Error('fileName / fileSize / mimeType は必須です');
  }
  var res = fetchWithRetry_(GEMINI_BASE + '/upload/v1beta/files?key=' + apiKey_(), {
    method: 'post',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(d.fileSize),
      'X-Goog-Upload-Header-Content-Type': d.mimeType
    },
    contentType: 'application/json',
    payload: JSON.stringify({ file: { display_name: String(d.fileName).slice(0, 100) } })
  });
  var headers = res.getHeaders();
  var uploadUrl = headers['x-goog-upload-url'] || headers['X-Goog-Upload-URL'];
  if (!uploadUrl) throw new Error('アップロードURLが取得できませんでした');
  // Geminiが返すURLにはAPIキー（key=）が含まれる。アップロードは upload_id だけで通るので、
  // キーは必ず取り除いてからブラウザへ渡す（利用者にAPIキーを見せない）
  return { uploadUrl: stripApiKey_(uploadUrl) };
}

/** URLのクエリから key= を取り除く */
function stripApiKey_(url) {
  var parts = String(url).split('?');
  if (parts.length < 2) return url;
  var query = parts.slice(1).join('?').split('&').filter(function (kv) {
    return kv && kv.split('=')[0] !== 'key';
  });
  return parts[0] + (query.length ? '?' + query.join('&') : '');
}

/** ブラウザから渡されたURLが、Geminiのアップロードセッションであることを確認する */
function assertUploadUrl_(url) {
  var ok = /^https:\/\/generativelanguage\.googleapis\.com\/upload\/v1beta\/files\?/.test(String(url || '')) &&
    /[?&]upload_id=[A-Za-z0-9_\-]+/.test(url);
  if (!ok) throw new Error('アップロードURLが不正です');
  return stripApiKey_(url);
}

/**
 * アップロード完了の確認（ブラウザが結果を読めなかったときの代わり）。
 * Geminiのアップロード完了レスポンスにはCORSヘッダーが付かないため、ブラウザからは
 * 「ネットワークエラー」に見える。実際には届いているので、サーバー側でセッションの状態を問い合わせる。
 */
function uploadResult(d) {
  var url = assertUploadUrl_(d.uploadUrl);
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { 'X-Goog-Upload-Command': 'query' },
    muteHttpExceptions: true
  });
  var headers = res.getHeaders();
  var status = headers['x-goog-upload-status'] || headers['X-Goog-Upload-Status'] || '';
  var received = Number(headers['x-goog-upload-size-received'] || headers['X-Goog-Upload-Size-Received'] || 0);
  if (res.getResponseCode() >= 400) {
    return { status: 'error', received: received, message: res.getContentText().slice(0, 300) };
  }
  if (status !== 'final') return { status: status || 'unknown', received: received };
  var body = JSON.parse(res.getContentText() || '{}');
  return { status: 'final', received: received, file: body.file || null };
}

/** Gemini側のファイル処理状態を返す（ACTIVEになるまでクライアントがポーリング） */
function fileStatus(d) {
  var res = fetchWithRetry_(
    GEMINI_BASE + '/v1beta/' + d.geminiFileName + '?key=' + apiKey_(), { method: 'get' });
  var file = JSON.parse(res.getContentText());
  return {
    state: file.state,
    uri: file.uri,
    mimeType: file.mimeType,
    name: file.name,
    error: file.error ? (file.error.message || JSON.stringify(file.error)) : null,
    // ブラウザで長さを取れないMOV等のフォールバック用
    videoDuration: (file.videoMetadata && file.videoMetadata.videoDuration) || null
  };
}

/** Gemini側の一時ファイルを削除（後始末）。複数指定可 */
function deleteFile(d) {
  var names = d.geminiFileNames || (d.geminiFileName ? [d.geminiFileName] : []);
  names.forEach(function (name) {
    try {
      UrlFetchApp.fetch(GEMINI_BASE + '/v1beta/' + name + '?key=' + apiKey_(),
        { method: 'delete', muteHttpExceptions: true });
    } catch (e) { /* 後始末の失敗は無視 */ }
  });
  return { deleted: names.length };
}

function safetySettings_() {
  return ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
    .map(function (c) { return { category: c, threshold: 'BLOCK_NONE' }; });
}

/**
 * generateContent 共通処理
 * opts: { temperature, thinkingBudget (2.5 flash系のみ有効。null=既定), mediaResolution }
 */
function generate_(parts, opts) {
  opts = opts || {};
  var model = model_();
  var generationConfig = {
    temperature: opts.temperature == null ? 0.2 : opts.temperature,
    maxOutputTokens: 65536
  };
  // 思考の有無はモデルにより指定方法が違うため、確実に効く 2.5 flash 系だけ明示する
  if (opts.thinkingBudget != null && /2\.5-flash/.test(model)) {
    generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
  }
  if (opts.mediaResolution) generationConfig.mediaResolution = opts.mediaResolution;

  var res = fetchWithRetry_(
    GEMINI_BASE + '/v1beta/models/' + model + ':generateContent?key=' + apiKey_(), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: parts }],
        generationConfig: generationConfig,
        safetySettings: safetySettings_()
      })
    });
  var result = JSON.parse(res.getContentText());
  if (result.promptFeedback && result.promptFeedback.blockReason) {
    throw new Error('Geminiが入力をブロックしました: ' + result.promptFeedback.blockReason);
  }
  var cand = result.candidates && result.candidates[0];
  var text = (cand && cand.content && cand.content.parts)
    ? cand.content.parts.filter(function (p) { return !p.thought; })
        .map(function (p) { return p.text || ''; }).join('')
    : '';
  var finishReason = (cand && cand.finishReason) || '';
  if (!text.trim()) {
    throw new Error('Geminiの応答が空でした' + (finishReason ? '（finishReason: ' + finishReason + '）' : ''));
  }
  return { text: stripCodeFence_(text.trim()), finishReason: finishReason };
}

/** ```で囲って返してきた場合の剥がし */
function stripCodeFence_(text) {
  var m = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return m ? m[1].trim() : text;
}

// ================================================================ 文字起こし

function fmtTime_(sec) {
  sec = Math.max(0, Math.floor(sec));
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(h) + ':' + p(m) + ':' + p(s);
}

/**
 * d: {
 *   fileUri, mimeType,
 *   mode: 'chunk' | 'whole',
 *     chunk … ブラウザが切り出した区間だけの音声ファイル。タイムスタンプはその音声の先頭基準
 *     whole … ファイル全体。audioStart〜audioEnd の範囲だけを書き起こす（動画はAPI側で区間指定）
 *   audioStart, audioEnd (秒), isVideo,
 *   speakers (bool), hint (string), prevTail (直前チャンク末尾。話者記号を揃える参考)
 * }
 */
function transcribe(d) {
  if (!d.fileUri || !d.mimeType) throw new Error('fileUri / mimeType は必須です');
  var whole = d.mode === 'whole';
  // 長さが取れず範囲を決められない場合は、ファイル全体を一括で書き起こす
  var ranged = whole && Number(d.audioEnd) > Number(d.audioStart);
  var dic = readDict_();
  var lines = [];

  if (whole && ranged) {
    lines.push('あなたはプロの文字起こし担当者です。添付の' + (d.isVideo ? '動画' : '音声') +
      'のうち【' + fmtTime_(d.audioStart) + '〜' + fmtTime_(d.audioEnd) +
      '】の範囲を、一言一句忠実に日本語で文字起こししてください。');
  } else if (whole) {
    lines.push('あなたはプロの文字起こし担当者です。添付の' + (d.isVideo ? '動画' : '音声') +
      'の内容を最初から最後まで、一言一句忠実に日本語で文字起こししてください。');
  } else {
    lines.push('あなたはプロの文字起こし担当者です。添付の音声を、一言一句忠実に日本語で文字起こししてください。');
  }
  if (d.hint) lines.push('\n【この音声について（固有名詞や用語の参考にする）】\n' + String(d.hint).slice(0, 2000));

  lines.push('\n【出力ルール】');
  if (whole) {
    if (ranged) lines.push('・指定範囲の外の内容は書かない');
    lines.push('・1行に1発言。各行の先頭に [HH:MM:SS] 形式で、ファイル全体の先頭からの経過時間（その発言の開始時刻）を付ける。例: [00:18:05] 話者A: では始めます。');
  } else {
    lines.push('・1行に1発言。各行の先頭に [MM:SS] 形式で、この音声の先頭からの経過時間（その発言の開始時刻）を付ける。例: [03:15] 話者A: では始めます。');
  }
  lines.push('・1つの発言が長い場合は、意味の切れ目で30秒以内ごとに行を分ける');
  if (d.speakers !== false) {
    lines.push('・話者が複数いる場合は「話者A: 」「話者B: 」のように区別し、同じ人物には最後まで同じ記号を使う。1人だけなら話者記号は付けない');
  } else {
    lines.push('・話者記号（話者A: など）は付けない');
  }
  lines.push('・「えー」「あのー」などのフィラーだけを省き、それ以外の発言は省略・要約・言い換えをしない');
  lines.push('・無音・音楽・雑音だけの区間には何も書かない。聞こえない発言を推測で作らない');
  lines.push('・聞き取れない箇所は（聞き取り不能）と書く');
  lines.push('・数字・固有名詞・専門用語は、文脈に合う正しい表記にする');
  lines.push('・前置き・説明・見出し・コードブロックは付けず、文字起こしの行だけを出力する');
  lines.push(buildDictPrompt_(dic));
  if (d.prevTail) {
    lines.push('\n【直前の区間の文字起こしの末尾（話者の記号を同じ人物に揃えるための参考）】\n' +
      String(d.prevTail).slice(0, 1200) +
      '\n※この音声に同じ発言が含まれていれば、そのまま書き出してよい（重複は後で機械的に取り除く）');
  }
  var prompt = lines.join('\n');

  var filePart = { fileData: { mimeType: d.mimeType, fileUri: d.fileUri } };
  var opts = { temperature: 0.2, thinkingBudget: 0 };
  if (whole && d.isVideo) {
    // 動画は音声さえ聞ければよいので低解像度で処理（トークン量を約1/3に）し、区間はAPI側で切る
    opts.mediaResolution = 'MEDIA_RESOLUTION_LOW';
    if (ranged) {
      filePart.videoMetadata = {
        startOffset: Math.floor(d.audioStart) + 's',
        endOffset: Math.ceil(d.audioEnd) + 's'
      };
    }
  }
  var out = generate_([filePart, { text: prompt }], opts);
  return { text: out.text, finishReason: out.finishReason, truncated: out.finishReason === 'MAX_TOKENS' };
}

// ================================================================ 整形・要約

// 整形・要約の指示の既定値。利用者は画面の「カスタム指示」で丸ごと差し替えられる。
// 「本文のみを出力」「辞書」「分割の注意」「直前の末尾」「文字起こし本体」は、差し替えても必ず付く。
var DEFAULT_REFINE_PROMPT =
  '以下の文字起こしテキストを、内容を保ったまま読みやすく整形してください。\n' +
  '・フィラーや言い直しを取り除き、話し言葉のくだけた表現は残しつつ句読点を整える\n' +
  '・意味のまとまりで段落分けする（1段落は長くても数行）\n' +
  '・内容の追加・要約・省略・言い換えはしない（読みやすくする整形のみ）\n' +
  '・行頭の [HH:MM:SS] タイムスタンプは、段落の先頭に残す（段落内の途中のものは省いてよい）\n' +
  '・話者表記（話者A: など）は残す';

var DEFAULT_SUMMARY_PROMPT =
  '以下の文字起こし全体を読み、次の構成で日本語の要約を作成してください。\n' +
  '■概要\n（3〜5行で全体を要約）\n' +
  '■主なトピック\n（箇条書き。入力にタイムスタンプがあれば各項目の先頭に [HH:MM:SS] を添える）\n' +
  '■重要な発言・ポイント\n（箇条書き。後で読み返す人が押さえるべき点）\n' +
  '■決定事項・TODO\n（該当がある場合のみ。無ければこの見出しごと省略）';

var CUSTOM_PROMPT_MAX = 4000;

/** 利用者のカスタム指示（空なら既定の指示） */
function promptOrDefault_(custom, def) {
  var text = String(custom || '').trim();
  return text ? text.slice(0, CUSTOM_PROMPT_MAX) : def;
}

/** 画面の「既定の指示を読み込む」ボタン用 */
function promptDefaults() {
  return { refine: DEFAULT_REFINE_PROMPT, summarize: DEFAULT_SUMMARY_PROMPT, maxLength: CUSTOM_PROMPT_MAX };
}

/** d: { text, chunkIndex, totalChunks, prevTail, customPrompt } — 整形（長文は分割して順に呼ばれる） */
function refine(d) {
  var dic = readDict_();
  var part = (d.totalChunks > 1)
    ? '\n（これは全' + d.totalChunks + '分割中の' + (d.chunkIndex + 1) +
      '番目の部分です。冒頭や末尾が文の途中でも、補ったり削ったりしないこと）'
    : '';
  var prompt = promptOrDefault_(d.customPrompt, DEFAULT_REFINE_PROMPT) + part + '\n' +
    '・前置きや説明は書かず、結果の本文のみを出力する' +
    buildDictPrompt_(dic) +
    (d.prevTail ? '\n\n【直前の部分の結果の末尾（文体・話者表記を揃える参考。再出力しない）】\n' + String(d.prevTail).slice(0, 600) : '') +
    '\n\n【文字起こしテキスト】\n' + d.text;
  return { text: generate_([{ text: prompt }], { temperature: 0.3, thinkingBudget: 0 }).text };
}

/** d: { text, hint, customPrompt } — 全体要約 */
function summarize(d) {
  var prompt = promptOrDefault_(d.customPrompt, DEFAULT_SUMMARY_PROMPT) + '\n' +
    (d.hint ? '（この音声について: ' + String(d.hint).slice(0, 1000) + '）\n' : '') +
    '前置きや説明は書かず、結果の本文のみを出力してください。' +
    '\n\n【文字起こし】\n' + d.text;
  return { text: generate_([{ text: prompt }], { temperature: 0.4 }).text };
}

// ================================================================ ライセンスキー
// 保存先: 辞書と同じスプレッドシートの「ライセンス」タブ（LICENSE_SHEET_ID を設定すれば別のスプレッドシートにできる）
// 列: A=キー / B=名前 / C=状態 / D=有効期限 / E=月の上限(分) / F=集計月 / G=今月の利用(分) / H=最終利用 / I=メモ
// 発行: B列に名前を書く → GASエディタで issueLicenseKeys を実行 → A列にキーが入る

var LICENSE_TAB = 'ライセンス';
var USAGE_TAB = '利用ログ';
var LICENSE_HEADERS = ['キー', '名前', '状態（有効/停止）', '有効期限（空欄=無期限）', '月の上限(分)（空欄=無制限）',
  '集計月', '今月の利用(分)', '最終利用', 'メモ'];
var LICENSE_CACHE_SEC = 300; // 停止・期限切れが反映されるまでの最大時間
var KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 読み間違えやすい 0/O/1/I を除外

function licenseError_(message, code) {
  var err = new Error(message);
  err.licenseCode = code || 'LICENSE_INVALID';
  return err;
}

function licenseBook_() {
  var id = cfg_('LICENSE_SHEET_ID') || cfg_('DICT_SHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ DICT_SHEET_ID（または LICENSE_SHEET_ID）が設定されていません');
  return SpreadsheetApp.openById(id);
}

/** 名前付きタブを取得（無ければ末尾に作る。辞書は1枚目のシートを使うので、必ず末尾に足す） */
function tab_(name, headers) {
  var book = licenseBook_();
  var sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name, book.getSheets().length);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function licenseSheet_() {
  return tab_(LICENSE_TAB, LICENSE_HEADERS);
}

/** 入力ゆれを吸収: 前後・途中の空白、小文字、全角や別種のハイフン */
function normalizeKey_(key) {
  return String(key || '').toUpperCase()
    .replace(/[\s　]/g, '')
    .replace(/[‐-―−ー－ｰ]/g, '-');
}

function monthStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

/** 台帳からキーの行を探す。見つからなければ null */
function findLicense_(key) {
  var sheet = licenseSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, 1, lastRow - 1, LICENSE_HEADERS.length).getValues();
  for (var i = 0; i < values.length; i++) {
    if (normalizeKey_(values[i][0]) !== key) continue;
    var v = values[i];
    var expires = null;
    if (v[3] instanceof Date) {
      expires = v[3];
    } else if (String(v[3]).trim()) {
      expires = new Date(String(v[3]).trim().replace(/[\/.]/g, '-'));
    }
    return {
      row: i + 2,
      key: key,
      name: String(v[1]).trim(),
      status: String(v[2]).trim(),
      expires: expires && !isNaN(expires.getTime()) ? expires.getTime() : null,
      limitMin: Number(v[4]) > 0 ? Number(v[4]) : null,
      month: v[5] instanceof Date ? Utilities.formatDate(v[5], 'Asia/Tokyo', 'yyyy-MM') : String(v[5]).trim(),
      usedMin: Number(v[6]) || 0
    };
  }
  return null;
}

/** 有効期限は、その日の終わり（日本時間）まで使える */
function isExpired_(lic) {
  if (lic.expires == null) return false;
  var day = Utilities.formatDate(new Date(lic.expires), 'Asia/Tokyo', 'yyyy-MM-dd');
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  return today > day;
}

function assertUsable_(lic) {
  if (!lic) throw licenseError_('ライセンスキーが正しくありません。入力内容を確認してください');
  if (/停止|無効|stop|disabled/i.test(lic.status)) {
    throw licenseError_('このライセンスキーは停止されています。管理者にお問い合わせください');
  }
  if (isExpired_(lic)) throw licenseError_('このライセンスキーは有効期限が切れています。管理者にお問い合わせください');
}

/**
 * ライセンスキーを照合して台帳の情報を返す。無効なら licenseCode 付きの例外。
 * 台帳の読み取りは重いので、有効と分かったキーは数分キャッシュする。
 */
function verifyLicense_(rawKey) {
  var key = normalizeKey_(rawKey);
  if (!key) throw licenseError_('ライセンスキーを入力してください', 'LICENSE_REQUIRED');
  var cache = CacheService.getScriptCache();
  var cacheKey = 'lic:' + key;
  var cached = cache.get(cacheKey);
  if (cached) {
    var hit = JSON.parse(cached);
    assertUsable_(hit); // 期限はキャッシュ中でも見る
    return hit;
  }
  var lic = findLicense_(key);
  if (!lic) Utilities.sleep(1500); // 総当たりを遅くする
  assertUsable_(lic);
  cache.put(cacheKey, JSON.stringify(lic), LICENSE_CACHE_SEC);
  return lic;
}

function licensePublic_(lic) {
  return {
    name: lic.name,
    expires: lic.expires ? Utilities.formatDate(new Date(lic.expires), 'Asia/Tokyo', 'yyyy-MM-dd') : null,
    limitMin: lic.limitMin
  };
}

function usageMinutes_(d) {
  var minutes = Math.max(0, (Number(d.audioEnd) || 0) - (Number(d.audioStart) || 0)) / 60;
  return Math.round(minutes * 10) / 10;
}

/** 月の上限がある人だけ、実行前に最新の台帳で残りを確認する */
function checkUsageLimit_(lic, d) {
  if (lic.limitMin == null) return;
  var fresh = findLicense_(lic.key);
  assertUsable_(fresh);
  if (fresh.limitMin == null) return;
  var used = fresh.month === monthStamp_() ? fresh.usedMin : 0;
  if (used + usageMinutes_(d) > fresh.limitMin) {
    throw licenseError_('今月の利用上限（' + fresh.limitMin + '分）に達しました。管理者にお問い合わせください', 'LICENSE_LIMIT');
  }
}

/** 文字起こし1区間ぶんの利用を台帳に加算する。月が変わっていたら集計をリセット。失敗しても結果は返す */
function addUsage_(lic, d) {
  var minutes = usageMinutes_(d);
  try {
    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      var fresh = findLicense_(lic.key);
      if (fresh) {
        var month = monthStamp_();
        var used = (fresh.month === month ? fresh.usedMin : 0) + minutes;
        licenseSheet_().getRange(fresh.row, 6, 1, 3)
          .setValues([["'" + month, Math.round(used * 10) / 10, nowStamp_()]]);
      }
    } finally {
      lock.releaseLock();
    }
  } catch (e) { /* 集計の失敗で文字起こし結果を捨てない */ }
  logUsage_(lic, 'transcribe', minutes);
}

/** 利用ログ（誰が・いつ・何を・何分）。失敗しても本処理は止めない */
function logUsage_(lic, action, minutes) {
  try {
    tab_(USAGE_TAB, ['日時', '名前', 'キー末尾', '操作', '分'])
      .appendRow([nowStamp_(), lic.name, lic.key.slice(-4), action, minutes || '']);
  } catch (e) { /* ログの失敗は無視 */ }
}

function generateKey_() {
  var groups = [];
  for (var g = 0; g < 3; g++) {
    var part = '';
    for (var i = 0; i < 4; i++) part += KEY_ALPHABET.charAt(Math.floor(Math.random() * KEY_ALPHABET.length));
    groups.push(part);
  }
  return 'MOJI-' + groups.join('-');
}

/**
 * 【管理者がGASエディタで実行】名前（B列）が入っていてキー（A列）が空の行に、キーを発行する。
 * 状態が空なら「有効」を入れる。既存のキーは変更しない。
 */
function issueLicenseKeys() {
  var sheet = licenseSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('「ライセンス」タブを用意しました。B列に名前を書いてから、もう一度実行してください。');
    return 0;
  }
  var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  var existing = {};
  values.forEach(function (v) { if (String(v[0]).trim()) existing[normalizeKey_(v[0])] = true; });
  var issued = 0;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() || !String(values[i][1]).trim()) continue;
    var key;
    do { key = generateKey_(); } while (existing[key]);
    existing[key] = true;
    sheet.getRange(i + 2, 1).setValue(key);
    if (!String(values[i][2]).trim()) sheet.getRange(i + 2, 3).setValue('有効');
    issued++;
    Logger.log(values[i][1] + ' : ' + key);
  }
  Logger.log(issued + '件のキーを発行しました');
  return issued;
}

/** doGet の診断用（キーそのものは出さない） */
function licenseDiag_() {
  try {
    var sheet = licenseSheet_();
    var lastRow = sheet.getLastRow();
    var count = 0;
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function (v) { if (String(v[0]).trim()) count++; });
    }
    return '「' + LICENSE_TAB + '」タブOK（発行済みキー ' + count + '件）';
  } catch (err) {
    return '開けません: ' + err.message;
  }
}

// ================================================================ チーム共有辞書
// 保存先: 管理者のDrive内スプレッドシート（DICT_SHEET_ID）の1枚目のシート
// 列: A=表記 / B=読み / C=誤認識例（|区切り）    ※毎回読み直すので登録が即チームに反映される

function dictSheet_() {
  var id = cfg_('DICT_SHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ DICT_SHEET_ID が設定されていません');
  var sheet = SpreadsheetApp.openById(id).getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['表記', '読み', '誤認識例（|区切り）']);
  }
  return sheet;
}

function readDict_() {
  var sheet;
  try {
    sheet = dictSheet_();
  } catch (e) {
    return []; // 辞書未設定でも文字起こし自体は動かす
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  var entries = [];
  for (var i = 0; i < values.length; i++) {
    var surface = String(values[i][0]).trim();
    if (!surface) continue;
    var wrongs = String(values[i][2]).split('|')
      .map(function (w) { return w.trim(); })
      .filter(function (w) { return w && w !== surface; });
    entries.push({ surface: surface, reading: String(values[i][1]).trim(), wrongs: wrongs });
  }
  return entries;
}

function writeDict_(entries) {
  var sheet = dictSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, 3).clearContent();
  if (entries.length) {
    var rows = entries.map(function (e) {
      return [e.surface, e.reading || '', (e.wrongs || []).join('|')];
    });
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }
}

function buildDictPrompt_(dic) {
  if (!dic.length) return '';
  var rows = dic.map(function (e) {
    var row = '- 「' + (e.reading || e.surface) + '」と聞こえたら必ず「' + e.surface + '」と表記する';
    if (e.wrongs.length) {
      row += '（「' + e.wrongs.join('」「') + '」は全部「' + e.surface + '」の聞き間違い）';
    }
    return row;
  });
  return '\n【固有名詞辞書（最優先で適用）】\n' + rows.join('\n');
}

function dictGet() {
  return { entries: readDict_() };
}

/** d: { entries: [{surface, reading, wrongs[]}] } — 既存の表記があれば誤認識例をマージ */
function dictAdd(d) {
  if (!d.entries || !d.entries.length) throw new Error('登録する辞書エントリがありません');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var entries = readDict_();
    d.entries.forEach(function (add) {
      if (!add.surface) return;
      var hit = null;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].surface === add.surface) { hit = entries[i]; break; }
      }
      if (hit) {
        (add.wrongs || []).forEach(function (w) {
          if (w && w !== add.surface && hit.wrongs.indexOf(w) === -1) hit.wrongs.push(w);
        });
        if (add.reading && !hit.reading) hit.reading = add.reading;
      } else {
        entries.push({
          surface: add.surface,
          reading: add.reading || '',
          wrongs: (add.wrongs || []).filter(function (w) { return w && w !== add.surface; })
        });
      }
    });
    writeDict_(entries);
    return { entries: entries };
  } finally {
    lock.releaseLock();
  }
}

/** d: { entries } — 辞書全体を上書き（辞書管理画面の保存用） */
function dictUpdate(d) {
  if (!d.entries) throw new Error('entries は必須です');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var entries = d.entries.filter(function (e) { return e.surface && String(e.surface).trim(); })
      .map(function (e) {
        var surface = String(e.surface).trim();
        return {
          surface: surface,
          reading: String(e.reading || '').trim(),
          wrongs: (e.wrongs || []).map(function (w) { return String(w).trim(); })
            .filter(function (w) { return w && w !== surface; })
        };
      });
    writeDict_(entries);
    return { entries: entries };
  } finally {
    lock.releaseLock();
  }
}
