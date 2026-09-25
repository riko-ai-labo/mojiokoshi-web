/**
 * ログインユーザー本人のGoogleドライブへの保存
 * drive.fileスコープ（このアプリが作ったファイルのみ操作可）で、
 * 「MOJI-OKO」フォルダを作り、その中に
 * シート1「文字起こし」／シート2「要約・整形」の2シート構成のスプレッドシートを作成する。
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const FOLDER_NAME = 'MOJI-OKO';

async function apiFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google APIエラー (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** アプリ用フォルダを取得（無ければ作成） */
async function ensureFolder(token) {
  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const found = await apiFetch(token, `${DRIVE_API}/files?q=${q}&fields=files(id,name)`);
  if (found.files?.length) return found.files[0].id;

  const created = await apiFetch(token, `${DRIVE_API}/files`, {
    method: 'POST',
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  return created.id;
}

/** 「[HH:MM:SS] 本文」形式の行を [タイムスタンプ, 本文] に分解 */
function transcriptToRows(text) {
  const rows = [['タイムスタンプ', 'テキスト']];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(.*)$/);
    if (m) {
      rows.push([m[1], m[2]]);
    } else {
      rows.push(['', line]);
    }
  }
  return rows;
}

function summaryRefinedToRows(summaryText, refinedText) {
  const rows = [['■ 要約']];
  for (const line of summaryText.split('\n')) rows.push([line]);
  rows.push(['']);
  rows.push(['■ 整形テキスト']);
  for (const line of refinedText.split('\n')) rows.push([line]);
  return rows;
}

/**
 * 保存の実行。戻り値: { url, folderId }
 */
export async function saveToDrive(token, { title, transcriptText, refinedText, summaryText }) {
  const folderId = await ensureFolder(token);

  // スプレッドシート作成（Drive API経由で親フォルダを指定）
  const file = await apiFetch(token, `${DRIVE_API}/files`, {
    method: 'POST',
    body: JSON.stringify({
      name: title,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [folderId],
    }),
  });
  const ssId = file.id;

  // シート構成: 1枚目を「文字起こし」に改名し、「要約・整形」を追加
  const meta = await apiFetch(token, `${SHEETS_API}/${ssId}?fields=sheets.properties`);
  const firstSheetId = meta.sheets[0].properties.sheetId;

  await apiFetch(token, `${SHEETS_API}/${ssId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: firstSheetId, title: '文字起こし' },
            fields: 'title',
          },
        },
        { addSheet: { properties: { sheetId: 1, title: '要約・整形' } } },
        // 列幅と折り返し（読みやすさ用）
        {
          updateDimensionProperties: {
            range: { sheetId: firstSheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
            properties: { pixelSize: 700 },
            fields: 'pixelSize',
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId: 1, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
            properties: { pixelSize: 800 },
            fields: 'pixelSize',
          },
        },
        {
          repeatCell: {
            range: { sheetId: firstSheetId, startColumnIndex: 1, endColumnIndex: 2 },
            cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
            fields: 'userEnteredFormat.wrapStrategy',
          },
        },
        {
          repeatCell: {
            range: { sheetId: 1, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
            fields: 'userEnteredFormat.wrapStrategy',
          },
        },
      ],
    }),
  });

  // 値の書き込み
  await apiFetch(
    token,
    `${SHEETS_API}/${ssId}/values:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: [
          { range: "'文字起こし'!A1", values: transcriptToRows(transcriptText) },
          { range: "'要約・整形'!A1", values: summaryRefinedToRows(summaryText, refinedText) },
        ],
      }),
    }
  );

  return {
    url: `https://docs.google.com/spreadsheets/d/${ssId}`,
    folderId,
  };
}
