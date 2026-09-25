/**
 * チャンク文字起こしの結合（タイムスタンプ＋本文一致による重複除去）
 *
 * 各チャンクは担当区間の前後に「のりしろ」(overlap) を付けて文字起こしされるため、
 * 境界付近の発言は隣り合うチャンクの両方に現れる。ここでは
 *   1. タイムスタンプで「境界より前の発言は前チャンク、後ろは次チャンク」に振り分け
 *   2. 境界付近の数行を本文で突き合わせ、同じ発言が二重に残る／両方から落ちるのを防ぐ
 * という手順で決定的に結合する（LLMに「重複させないで」と頼む方式より安定）。
 *
 * DOM非依存。Node のテストからも使える。
 */

const TS_HEAD = /^\s*[\[［(（](\d{1,2}):(\d{2})(?::(\d{2}))?[\]］)）]\s*/;

/** 行頭の "[HH:MM:SS]" / "[MM:SS]" を秒に。無ければ null（括弧無しは本文中の時刻と区別できないので対象外） */
export function parseTs(str) {
  const m = String(str).match(TS_HEAD);
  if (!m) return null;
  if (m[3] !== undefined) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fmtTs(sec) {
  sec = Math.max(0, Math.round(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `[${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}]`;
}

/** テキストを { ts, body } の行配列にする（空行は捨てる） */
export function parseLines(text) {
  const lines = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const ts = parseTs(line);
    const body = ts === null ? line : line.replace(TS_HEAD, '').trim();
    if (!body) continue;
    lines.push({ ts, body });
  }
  return lines;
}

/** 行配列 → テキスト。withTimestamps=false ならタイムスタンプを落とす */
export function serializeLines(lines, withTimestamps = true) {
  return lines
    .map((l) => (withTimestamps && l.ts !== null ? `${fmtTs(l.ts)} ${l.body}` : l.body))
    .join('\n');
}

/**
 * チャンク内相対のタイムスタンプを絶対時刻に直す。
 * assumeRelative=true（切り出した音声を渡した場合）は常に offset を足す。
 * false（ファイル全体＋範囲指定の場合）はモデルが絶対時刻を書いたか相対で書いたかを推定する。
 */
export function absolutizeLines(lines, offsetSec, chunkLenSec, assumeRelative) {
  if (!offsetSec) return lines;
  const tsValues = lines.map((l) => l.ts).filter((t) => t !== null);
  if (!tsValues.length) return lines;
  let relative = assumeRelative;
  if (!assumeRelative) {
    const min = Math.min(...tsValues);
    const max = Math.max(...tsValues);
    // 絶対時刻なら最初の行は範囲開始（offset）付近から始まる。それより明らかに前なら相対
    relative = min < offsetSec - 60 && max <= chunkLenSec + 120;
  }
  if (!relative) return lines;
  return lines.map((l) => ({ ...l, ts: l.ts === null ? null : l.ts + offsetSec }));
}

// ---- 本文の類似判定

const SPEAKER_RE = /^(話者|speaker)\s*[A-Za-z0-9０-９一-龥ぁ-んァ-ン]{1,4}\s*[:：]\s*/i;

export function stripSpeaker(body) {
  return body.replace(SPEAKER_RE, '');
}

export function normalizeBody(body) {
  return stripSpeaker(body)
    .replace(/[\s　、。，．,.!?！?「」『』（）()・…〜~ー\-–—]/g, '')
    .toLowerCase();
}

/** 最長共通部分文字列の長さ（短い文字列専用） */
export function longestCommonSubstring(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      } else {
        cur[j] = 0;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return best;
}

/**
 * 0〜1。同じ発言と見なせるなら 0.7 以上になる想定。
 * 「〜と思います」のような定型の語尾だけで一致しないよう、共通部分は10文字以上を要求する。
 */
export function similarity(bodyA, bodyB) {
  const a = normalizeBody(bodyA);
  const b = normalizeBody(bodyB);
  if (a === b && a.length >= 4) return 1;
  const min = Math.min(a.length, b.length);
  if (min < 10) return 0;
  const lcs = longestCommonSubstring(a, b);
  if (lcs < 10) return 0;
  return lcs / min;
}

// ---- 結合

/**
 * acc（結合済み行）と cur（次チャンクの行）を boundary（担当区間の境目・秒）で結合する。
 */
export function joinAtBoundary(acc, cur, boundary, options = {}) {
  const threshold = options.threshold ?? 0.7;
  const window = options.window ?? 4;
  if (!acc.length) return cur.slice();
  if (!cur.length) return acc.slice();

  const firstAtOrAfter = (lines, fallback) => {
    const i = lines.findIndex((l) => l.ts !== null && l.ts >= boundary);
    return i === -1 ? fallback : i;
  };
  const hasTs = (lines) => lines.some((l) => l.ts !== null);
  const aStar = hasTs(acc) ? firstAtOrAfter(acc, acc.length) : acc.length;
  const cStar = hasTs(cur) ? firstAtOrAfter(cur, cur.length) : 0;

  // 境界付近の行を本文で突き合わせ、同じ発言のペアを探す
  let best = null;
  const aFrom = Math.max(0, aStar - window);
  const aTo = Math.min(acc.length, aStar + window);
  const cFrom = Math.max(0, cStar - window);
  const cTo = Math.min(cur.length, cStar + window);
  for (let a = aFrom; a < aTo; a++) {
    for (let c = cFrom; c < cTo; c++) {
      const s = similarity(acc[a].body, cur[c].body);
      if (s < threshold) continue;
      const dist = Math.abs(a - aStar) + Math.abs(c - cStar);
      if (!best || s > best.s + 1e-9 || (Math.abs(s - best.s) < 1e-9 && dist < best.dist)) {
        best = { a, c, s, dist };
      }
    }
  }

  if (!best) {
    return acc.slice(0, aStar).concat(cur.slice(cStar));
  }
  // 同じ発言が両方にある。境界より前に始まる発言は前チャンク側（文頭が欠けていない）を、
  // 境界以降なら次チャンク側（文末が切れていない）を採用する
  const ts = acc[best.a].ts ?? cur[best.c].ts;
  const preferAcc = ts !== null ? ts < boundary : acc[best.a].body.length >= cur[best.c].body.length;
  if (preferAcc) {
    return acc.slice(0, best.a + 1).concat(cur.slice(best.c + 1));
  }
  return acc.slice(0, best.a).concat(cur.slice(best.c));
}

/**
 * chunks: [{ nominalStart, lines }] （lines は絶対タイムスタンプ済み）を順に結合して行配列を返す
 */
export function mergeChunks(chunks, options = {}) {
  let acc = [];
  for (let i = 0; i < chunks.length; i++) {
    const lines = chunks[i].lines || [];
    acc = i === 0 ? lines.slice() : joinAtBoundary(acc, lines, chunks[i].nominalStart, options);
  }
  return acc;
}

/** 行頭のタイムスタンプを取り除く（オプションでタイムスタンプ無しにする用） */
export function stripTimestamps(text) {
  return String(text)
    .split('\n')
    .map((l) => l.replace(TS_HEAD, ''))
    .join('\n');
}
