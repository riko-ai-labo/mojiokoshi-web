/**
 * ブラウザ内での音声分割（デコード不要・ゼロコピー中心）
 *
 * 長時間ファイルを「音声だけ」「15分ずつ」に切り出してGeminiへ送るための下準備。
 *   - MP3      : フレーム境界で時間→バイト位置の索引を作り、Blob.sliceで切り出す
 *   - M4A/MP4/MOV : MP4コンテナを解析してAACトラックの生サンプルを取り出し、ADTS形式（.aac）に詰め直す
 *                  → 2GBの動画でも「音声部分（1分あたり約1MB）」しかアップロードしない
 *   - WAV      : PCMをバイト位置で切ってヘッダーを付け直す
 *
 * 解析できない形式（WebM、Opus、ALAC、フラグメントMP4など）は null を返し、
 * 呼び出し側はファイル丸ごとアップロード＋範囲指定のフォールバックへ切り替える。
 *
 * DOM非依存（Blob/File のみ）なので Node のテストからも使える。
 */

// ================================================================ 共通ヘルパー

async function readBytes(blob, start, end) {
  const buf = await blob.slice(start, Math.min(end, blob.size)).arrayBuffer();
  return new Uint8Array(buf);
}

function fourcc(u8, pos) {
  return String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
}

function u32(u8, pos) {
  return ((u8[pos] << 24) >>> 0) + (u8[pos + 1] << 16) + (u8[pos + 2] << 8) + u8[pos + 3];
}

function u64(u8, pos) {
  return u32(u8, pos) * 4294967296 + u32(u8, pos + 4);
}

function u16(u8, pos) {
  return (u8[pos] << 8) | u8[pos + 1];
}

/** sorted の中で value 以上となる最初のインデックス */
function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 大きなファイルを窓ごとに読みながら走査するためのリーダー。
 * at(pos, need) で pos から need バイトが載った Uint8Array と、その中での相対位置を返す。
 */
class WindowReader {
  constructor(blob, windowSize = 4 * 1024 * 1024) {
    this.blob = blob;
    this.windowSize = windowSize;
    this.start = 0;
    this.buf = new Uint8Array(0);
  }
  async at(pos, need) {
    if (pos < this.start || pos + need > this.start + this.buf.length) {
      if (pos + need > this.blob.size) return null;
      this.start = pos;
      this.buf = await readBytes(this.blob, pos, pos + Math.max(need, this.windowSize));
    }
    return { buf: this.buf, off: pos - this.start };
  }
}

// ================================================================ MP3

const MP3_BITRATE = {
  // [version][layer] → kbps 表（index 1..14）
  V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  V2L23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLERATE = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

/** 4バイトのフレームヘッダーを解析。無効なら null */
function parseMp3Header(u8, p) {
  if (u8[p] !== 0xff || (u8[p + 1] & 0xe0) !== 0xe0) return null;
  const version = (u8[p + 1] >> 3) & 3; // 0=2.5, 1=予約, 2=V2, 3=V1
  const layer = (u8[p + 1] >> 1) & 3; // 1=L3, 2=L2, 3=L1
  const bitrateIdx = u8[p + 2] >> 4;
  const srIdx = (u8[p + 2] >> 2) & 3;
  const padding = (u8[p + 2] >> 1) & 1;
  if (version === 1 || layer === 0 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) return null;
  const sr = MP3_SAMPLERATE[version][srIdx];
  let table;
  let samples;
  let frameLen;
  if (layer === 3) {
    table = version === 3 ? MP3_BITRATE.V1L1 : MP3_BITRATE.V2L1;
    samples = 384;
    frameLen = (Math.floor((12 * table[bitrateIdx] * 1000) / sr) + padding) * 4;
  } else if (layer === 2) {
    table = version === 3 ? MP3_BITRATE.V1L2 : MP3_BITRATE.V2L23;
    samples = 1152;
    frameLen = Math.floor((144 * table[bitrateIdx] * 1000) / sr) + padding;
  } else {
    table = version === 3 ? MP3_BITRATE.V1L3 : MP3_BITRATE.V2L23;
    samples = version === 3 ? 1152 : 576;
    frameLen = Math.floor(((version === 3 ? 144 : 72) * table[bitrateIdx] * 1000) / sr) + padding;
  }
  if (frameLen < 24) return null;
  return { version, layer, sr, frameLen, samples };
}

function id3v2Size(u8) {
  if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return 0;
  const size = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
  const footer = u8[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

async function analyzeMp3(file, onProgress) {
  const reader = new WindowReader(file);
  const head = await readBytes(file, 0, 16);
  let pos = id3v2Size(head);
  const size = file.size;
  const secOffsets = []; // secOffsets[k] = k秒以降で最初のフレームのバイト位置
  let time = 0;
  let frames = 0;
  let junk = 0;
  let lastReport = 0;

  while (pos + 4 <= size) {
    const w = await reader.at(pos, 4);
    if (!w) break;
    const h = parseMp3Header(w.buf, w.off);
    let ok = false;
    if (h) {
      // 偽同期対策: 次のフレーム位置にも整合するヘッダーがあるか確認（末尾は免除）
      const nextPos = pos + h.frameLen;
      if (nextPos + 4 > size) {
        ok = true;
      } else {
        const w2 = await reader.at(nextPos, 4);
        const h2 = w2 && parseMp3Header(w2.buf, w2.off);
        ok = !!(h2 && h2.version === h.version && h2.layer === h.layer && h2.sr === h.sr);
        if (!ok && frames > 0) {
          // 既に連続したフレーム列の中では、次が壊れていても現フレーム自体は信用する
          ok = true;
        }
      }
    }
    if (!ok) {
      pos++;
      junk++;
      if (junk > 2 * 1024 * 1024) break; // 2MB以上ゴミが続くなら終端扱い
      continue;
    }
    junk = 0;
    while (secOffsets.length <= Math.floor(time)) secOffsets.push(pos);
    time += h.samples / h.sr;
    frames++;
    pos += h.frameLen;
    if (onProgress && pos - lastReport > 8 * 1024 * 1024) {
      lastReport = pos;
      onProgress(pos / size);
    }
  }
  if (frames < 10 || time < 1) return null;
  const duration = time;
  const dataEnd = pos;

  return {
    kind: 'mp3',
    duration,
    audioBytes: dataEnd - (secOffsets[0] || 0),
    mimeType: 'audio/mp3',
    ext: 'mp3',
    async slice(startSec, endSec) {
      const a = secOffsets[Math.min(secOffsets.length - 1, Math.max(0, Math.floor(startSec)))];
      const endIdx = Math.ceil(endSec);
      const b = endIdx < secOffsets.length ? secOffsets[endIdx] : dataEnd;
      return file.slice(a, b, 'audio/mp3');
    },
  };
}

// ================================================================ MP4 / M4A / MOV（AAC → ADTS）

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** 子ボックスを列挙 */
function* boxes(u8, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(u8, p);
    const type = fourcc(u8, p + 4);
    let hdr = 8;
    if (size === 1) {
      size = u64(u8, p + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr) return;
    yield { type, start: p, body: p + hdr, end: Math.min(end, p + size) };
    p += size;
  }
}

function findBox(u8, start, end, type) {
  for (const b of boxes(u8, start, end)) if (b.type === type) return b;
  return null;
}

/** MP4の"expandable size"（1〜4バイト）を読む */
function readExpandable(u8, p) {
  let size = 0;
  for (let i = 0; i < 4; i++) {
    const b = u8[p++];
    size = (size << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { size, next: p };
}

/** esds ボックスから AudioSpecificConfig を取り出す */
function parseEsds(u8, body, end) {
  let p = body + 4; // version/flags
  // ES_Descriptor (0x03)
  if (u8[p] !== 0x03) return null;
  let r = readExpandable(u8, p + 1);
  p = r.next;
  const esFlags = u8[p + 2];
  p += 3;
  if (esFlags & 0x80) p += 2;
  if (esFlags & 0x40) p += 1 + u8[p];
  if (esFlags & 0x20) p += 2;
  // DecoderConfigDescriptor (0x04)
  if (u8[p] !== 0x04) return null;
  r = readExpandable(u8, p + 1);
  p = r.next;
  const objectType = u8[p];
  p += 13;
  // DecoderSpecificInfo (0x05)
  if (p >= end || u8[p] !== 0x05) return null;
  r = readExpandable(u8, p + 1);
  p = r.next;
  const asc = u8.subarray(p, Math.min(end, p + r.size));
  if (asc.length < 2) return null;
  let aot = asc[0] >> 3;
  let sfIdx = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  let chanCfg = (asc[1] >> 3) & 0xf;
  if (aot === 31) return null; // 拡張AOT（未対応）
  if (sfIdx === 15) {
    // 明示サンプリング周波数（24bit）→ 近いインデックスへ丸める
    if (asc.length < 5) return null;
    const freq = ((asc[1] & 0x7f) << 17) | (asc[2] << 9) | (asc[3] << 1) | (asc[4] >> 7);
    sfIdx = AAC_SAMPLE_RATES.findIndex((f) => Math.abs(f - freq) < 100);
    chanCfg = (asc[4] >> 3) & 0xf;
    if (sfIdx < 0) return null;
  }
  return { objectType, aot, sfIdx, chanCfg };
}

function parseAudioTrack(u8, trak) {
  const mdia = findBox(u8, trak.body, trak.end, 'mdia');
  if (!mdia) return null;
  const hdlr = findBox(u8, mdia.body, mdia.end, 'hdlr');
  if (!hdlr || fourcc(u8, hdlr.body + 8) !== 'soun') return null;
  const mdhd = findBox(u8, mdia.body, mdia.end, 'mdhd');
  if (!mdhd) return null;
  const mdhdVer = u8[mdhd.body];
  const timescale = mdhdVer === 1 ? u32(u8, mdhd.body + 20) : u32(u8, mdhd.body + 12);
  const minf = findBox(u8, mdia.body, mdia.end, 'minf');
  const stbl = minf && findBox(u8, minf.body, minf.end, 'stbl');
  if (!stbl) return null;

  // ---- stsd → mp4a → esds（MOVでは wave 内、v1/v2記述子ではオフセットがずれるので文字列探索）
  const stsd = findBox(u8, stbl.body, stbl.end, 'stsd');
  if (!stsd) return null;
  const entry = [...boxes(u8, stsd.body + 8, stsd.end)][0];
  if (!entry || entry.type !== 'mp4a') return null;
  let asc = null;
  for (let p = entry.body + 28; p + 8 <= entry.end; p++) {
    if (fourcc(u8, p + 4) === 'esds') {
      const size = u32(u8, p);
      asc = parseEsds(u8, p + 8, Math.min(entry.end, p + size));
      break;
    }
  }
  if (!asc) return null;
  if (![0x40, 0x66, 0x67, 0x68].includes(asc.objectType)) return null; // AAC以外
  if (![1, 2, 3, 4, 5, 29].includes(asc.aot)) return null;

  // ---- サンプル表
  const stts = findBox(u8, stbl.body, stbl.end, 'stts');
  const stsc = findBox(u8, stbl.body, stbl.end, 'stsc');
  const stsz = findBox(u8, stbl.body, stbl.end, 'stsz');
  const stco = findBox(u8, stbl.body, stbl.end, 'stco') || findBox(u8, stbl.body, stbl.end, 'co64');
  if (!stts || !stsc || !stsz || !stco) return null;

  const constSize = u32(u8, stsz.body + 4);
  const sampleCount = u32(u8, stsz.body + 8);
  if (sampleCount === 0) return null; // フラグメントMP4など
  const sizes = new Uint32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) sizes[i] = constSize || u32(u8, stsz.body + 12 + i * 4);

  const times = new Float64Array(sampleCount);
  let lastDelta = 0;
  {
    const n = u32(u8, stts.body + 4);
    let t = 0;
    let idx = 0;
    for (let i = 0; i < n && idx < sampleCount; i++) {
      const count = u32(u8, stts.body + 8 + i * 8);
      const delta = u32(u8, stts.body + 12 + i * 8);
      for (let k = 0; k < count && idx < sampleCount; k++) {
        times[idx++] = t / timescale;
        t += delta;
      }
    }
    while (idx < sampleCount) times[idx++] = t / timescale;
    lastDelta = n ? u32(u8, stts.body + 12 + (n - 1) * 8) / timescale : 0;
  }

  const offsets = new Float64Array(sampleCount);
  {
    const is64 = stco.type === 'co64';
    const chunkCount = u32(u8, stco.body + 4);
    const stscN = u32(u8, stsc.body + 4);
    const stscEntries = [];
    for (let i = 0; i < stscN; i++) {
      stscEntries.push({
        firstChunk: u32(u8, stsc.body + 8 + i * 12),
        perChunk: u32(u8, stsc.body + 12 + i * 12),
      });
    }
    let idx = 0;
    let e = 0;
    for (let c = 1; c <= chunkCount && idx < sampleCount; c++) {
      while (e + 1 < stscEntries.length && stscEntries[e + 1].firstChunk <= c) e++;
      const perChunk = stscEntries[e] ? stscEntries[e].perChunk : 0;
      let off = is64 ? u64(u8, stco.body + 8 + (c - 1) * 8) : u32(u8, stco.body + 8 + (c - 1) * 4);
      for (let k = 0; k < perChunk && idx < sampleCount; k++) {
        offsets[idx] = off;
        off += sizes[idx];
        idx++;
      }
    }
    if (idx < sampleCount) return null; // サンプル表が不整合
  }

  return {
    sfIdx: asc.sfIdx,
    chanCfg: asc.chanCfg,
    profile: asc.aot === 1 ? 0 : asc.aot === 3 ? 2 : asc.aot === 4 ? 3 : 1, // LC/HE-AACはLC扱い
    sizes,
    times,
    offsets,
    duration: times[sampleCount - 1] + lastDelta,
  };
}

function adtsHeader(profile, sfIdx, chanCfg, payloadLen) {
  const len = payloadLen + 7;
  return [
    0xff,
    0xf1, // MPEG-4, Layer 0, CRCなし
    (profile << 6) | (sfIdx << 2) | ((chanCfg >> 2) & 1),
    ((chanCfg & 3) << 6) | ((len >> 11) & 3),
    (len >> 3) & 0xff,
    ((len & 7) << 5) | 0x1f,
    0xfc,
  ];
}

async function analyzeMp4(file, onProgress) {
  const size = file.size;
  // トップレベルのボックスを歩いて moov を探す（動画ファイルは mdat の後ろにあることも多い）
  let pos = 0;
  let moov = null;
  while (pos + 8 <= size) {
    const h = await readBytes(file, pos, pos + 16);
    if (h.length < 8) break;
    let boxSize = u32(h, 0);
    const type = fourcc(h, 4);
    if (boxSize === 1) boxSize = u64(h, 8);
    else if (boxSize === 0) boxSize = size - pos;
    if (boxSize < 8) return null;
    if (type === 'moov') {
      moov = { start: pos, size: boxSize };
      break;
    }
    pos += boxSize;
  }
  if (!moov) return null;
  if (moov.size > 64 * 1024 * 1024) return null; // 異常に大きい moov は扱わない
  const u8 = await readBytes(file, moov.start, moov.start + moov.size);
  const root = { body: 8, end: u8.length };
  if (u32(u8, 0) === 1) root.body = 16;

  let track = null;
  for (const b of boxes(u8, root.body, root.end)) {
    if (b.type !== 'trak') continue;
    track = parseAudioTrack(u8, b);
    if (track) break;
  }
  if (!track) return null;
  onProgress?.(1);

  const { sizes, times, offsets, sfIdx, chanCfg, profile } = track;
  let audioBytes = 7 * sizes.length;
  for (let i = 0; i < sizes.length; i++) audioBytes += sizes[i];

  return {
    kind: 'aac',
    duration: track.duration,
    audioBytes,
    mimeType: 'audio/aac',
    ext: 'aac',
    async slice(startSec, endSec) {
      const first = lowerBound(times, startSec);
      const last = Math.max(first, lowerBound(times, endSec)); // exclusive
      // 連続領域ごとにまとめて読む（動画とインターリーブされていると細切れになるため、
      // 間隔が小さければ1回の読み込みで複数の塊を拾う）
      let total = 7 * (last - first);
      for (let i = first; i < last; i++) total += sizes[i];
      const out = new Uint8Array(total);
      let op = 0;
      let i = first;
      while (i < last) {
        // 読み込み窓を決める: 音声バイト量の2倍＋1MBまでは隙間を許容してまとめる
        const winStart = offsets[i];
        let j = i;
        let audioBytes = 0;
        let winEnd = winStart;
        while (j < last) {
          const s = offsets[j];
          const e = s + sizes[j];
          if (e - winStart > audioBytes * 2 + 1024 * 1024 && j > i) break;
          audioBytes += sizes[j];
          winEnd = Math.max(winEnd, e);
          j++;
        }
        const buf = await readBytes(file, winStart, winEnd);
        for (let k = i; k < j; k++) {
          const rel = offsets[k] - winStart;
          out.set(adtsHeader(profile, sfIdx, chanCfg, sizes[k]), op);
          op += 7;
          out.set(buf.subarray(rel, rel + sizes[k]), op);
          op += sizes[k];
        }
        i = j;
      }
      return new Blob([out], { type: 'audio/aac' });
    },
  };
}

// ================================================================ WAV

async function analyzeWav(file) {
  const head = await readBytes(file, 0, Math.min(file.size, 1024 * 1024));
  if (head.length < 12 || fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'WAVE') return null;
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= head.length) {
    const id = fourcc(head, p);
    const len = head[p + 4] | (head[p + 5] << 8) | (head[p + 6] << 16) | ((head[p + 7] << 24) >>> 0);
    if (id === 'fmt ') fmt = { start: p, end: p + 8 + len };
    if (id === 'data') {
      data = { start: p + 8, end: Math.min(file.size, p + 8 + (len || file.size)) };
      break;
    }
    p += 8 + len + (len & 1);
  }
  if (!fmt || !data) return null;
  const byteRate = head[fmt.start + 16] | (head[fmt.start + 17] << 8) | (head[fmt.start + 18] << 16) | ((head[fmt.start + 19] << 24) >>> 0);
  const blockAlign = head[fmt.start + 20] | (head[fmt.start + 21] << 8);
  if (!byteRate || !blockAlign) return null;
  const fmtChunk = head.slice(fmt.start, fmt.end);
  const duration = (data.end - data.start) / byteRate;

  return {
    kind: 'wav',
    duration,
    audioBytes: data.end - data.start,
    mimeType: 'audio/wav',
    ext: 'wav',
    async slice(startSec, endSec) {
      const a = data.start + Math.floor((startSec * byteRate) / blockAlign) * blockAlign;
      const b = Math.min(data.end, data.start + Math.ceil((endSec * byteRate) / blockAlign) * blockAlign);
      const dataLen = Math.max(0, b - a);
      const header = new Uint8Array(12 + fmtChunk.length + 8);
      const dv = new DataView(header.buffer);
      header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
      dv.setUint32(4, 4 + fmtChunk.length + 8 + dataLen, true);
      header.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
      header.set(fmtChunk, 12);
      header.set([0x64, 0x61, 0x74, 0x61], 12 + fmtChunk.length); // data
      dv.setUint32(12 + fmtChunk.length + 4, dataLen, true);
      return new Blob([header, file.slice(a, b)], { type: 'audio/wav' });
    },
  };
}

// ================================================================ 入口

/**
 * ファイルを解析して { kind, duration, mimeType, ext, slice(start,end) } を返す。
 * 対応外なら null（呼び出し側はファイル丸ごとアップロードにフォールバック）。
 */
export async function analyzeMedia(file, onProgress) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    if (ext === 'mp3') return await analyzeMp3(file, onProgress);
    if (['m4a', 'mp4', 'mov', 'm4v'].includes(ext)) return await analyzeMp4(file, onProgress);
    if (ext === 'wav') return await analyzeWav(file);
  } catch (err) {
    console.warn('media-split: 解析に失敗したためフォールバックします', err);
  }
  return null;
}

/**
 * 分割計画。nominal（担当区間）と audio（前後に overlap を足した実際に切り出す区間）を返す。
 */
export function planChunks(duration, chunkSec, overlapSec) {
  const chunks = [];
  if (!duration || duration <= chunkSec + overlapSec) {
    return [{ index: 0, nominalStart: 0, nominalEnd: duration || 0, audioStart: 0, audioEnd: duration || 0 }];
  }
  let i = 0;
  for (let t = 0; t < duration; t += chunkSec, i++) {
    const nominalEnd = Math.min(t + chunkSec, duration);
    chunks.push({
      index: i,
      nominalStart: t,
      nominalEnd,
      audioStart: Math.max(0, t - overlapSec),
      audioEnd: Math.min(duration, nominalEnd + overlapSec),
    });
  }
  // 最後の切れ端が短すぎる場合は手前に吸収
  if (chunks.length > 1 && chunks[chunks.length - 1].nominalEnd - chunks[chunks.length - 1].nominalStart < 60) {
    const last = chunks.pop();
    chunks[chunks.length - 1].nominalEnd = last.nominalEnd;
    chunks[chunks.length - 1].audioEnd = last.audioEnd;
  }
  return chunks;
}
