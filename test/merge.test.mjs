// 実行方法: node test/merge.test.mjs
import {
  parseTs, fmtTs, parseLines, serializeLines, absolutizeLines,
  similarity, joinAtBoundary, mergeChunks, stripTimestamps,
} from '../js/merge.js';

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; console.log(`  ok: ${label}`); }
  else { failed++; console.error(`  NG: ${label}\n     expected: ${e}\n     actual:   ${a}`); }
}

console.log('parseTs / fmtTs');
eq(parseTs('[00:15:07] こんにちは'), 907, 'HH:MM:SS');
eq(parseTs('[03:15] こんにちは'), 195, 'MM:SS');
eq(parseTs('10:30に集合します'), null, '括弧無しの時刻は本文扱い');
eq(fmtTs(907), '[00:15:07]', 'fmt');
eq(parseLines('[00:01] 話者A: はい\n\n本文だけ\n[00:02]\n').map((l) => [l.ts, l.body]),
  [[1, '話者A: はい'], [null, '本文だけ']], 'parseLines');
eq(serializeLines(parseLines('[00:01] a\nb'), false), 'a\nb', 'タイムスタンプ無し出力');

console.log('absolutizeLines');
{
  const lines = parseLines('[00:05] a\n[14:50] b');
  eq(absolutizeLines(lines, 870, 960, true).map((l) => l.ts), [875, 1760], '相対→絶対（強制）');
  eq(absolutizeLines(lines, 870, 960, false).map((l) => l.ts), [875, 1760], '相対っぽければ足す（推定）');
  const abs = parseLines('[00:14:35] a\n[00:29:50] b');
  eq(absolutizeLines(abs, 870, 960, false).map((l) => l.ts), [875, 1790], '既に絶対ならそのまま');
}

console.log('similarity');
eq(similarity('話者A: 今日はクレアカについて説明します。', '話者B: 今日は、クレアカについて説明します'), 1, '句読点・話者差は無視');
eq(similarity('はい。', 'はい。') >= 0.7, false, '短すぎる行は一致扱いしない');
eq(similarity('全く別の話をしています', '来週の予定を確認しましょう') < 0.7, true, '別の発言');
eq(similarity('はい、そうだと思います', '私もそうだと思います') < 0.7, true, '定型の語尾だけでは一致しない');
eq(similarity('境界をまたぐ長い発言で、次のチャンクにも出てきます', '境界を跨ぐ長い発言で次のチャンクにも出てきます') >= 0.7, true, '表記ゆれがあっても同じ発言');

console.log('joinAtBoundary');
{
  // 境界 900秒。前チャンクは930まで、次チャンクは870から聞いている
  const acc = parseLines([
    '[00:14:30] 話者A: 前半の最後の話です。',
    '[00:14:55] 話者B: 境界をまたぐ長い発言で、次のチャンクにも出てきます。',
    '[00:15:10] 話者A: これは次のチャンクの担当です。',
  ].join('\n'));
  const cur = parseLines([
    '[00:14:56] 話者B: 境界をまたぐ長い発言で次のチャンクにも出てきます。',
    '[00:15:10] 話者A: これは次のチャンクの担当です。',
    '[00:15:40] 話者B: 後半の話。',
  ].join('\n'));
  const joined = joinAtBoundary(acc, cur, 900);
  eq(joined.map((l) => l.body), [
    '話者A: 前半の最後の話です。',
    '話者B: 境界をまたぐ長い発言で、次のチャンクにも出てきます。',
    '話者A: これは次のチャンクの担当です。',
    '話者B: 後半の話。',
  ], 'のりしろの重複が消え、境界前の発言は前チャンク版が残る');
}
{
  // タイムスタンプのズレで両方から落ちそうな発言が救われる
  const acc = parseLines('[00:14:40] 直前の話。\n[00:15:03] 境界ぴったりの発言でタイムスタンプがずれている。');
  const cur = parseLines('[00:14:58] 境界ぴったりの発言で、タイムスタンプがずれている。\n[00:15:20] 続きの話。');
  const joined = joinAtBoundary(acc, cur, 900);
  eq(joined.map((l) => l.body), [
    '直前の話。',
    '境界ぴったりの発言で、タイムスタンプがずれている。',
    '続きの話。',
  ], '境界付近の発言が1回だけ残る');
}
{
  // タイムスタンプ無し同士でも本文一致で結合できる
  const acc = parseLines('最初の発言です。\n次の発言はここで終わります。\n三番目の発言が両方に入っています。');
  const cur = parseLines('三番目の発言が両方に入っています。\n四番目の発言です。');
  eq(joinAtBoundary(acc, cur, 900).map((l) => l.body),
    ['最初の発言です。', '次の発言はここで終わります。', '三番目の発言が両方に入っています。', '四番目の発言です。'],
    'タイムスタンプ無しでも重複除去');
}
{
  // 一致が無ければタイムスタンプで単純に振り分け
  const acc = parseLines('[00:14:50] a\n[00:15:05] b(前チャンク版・捨てる)');
  const cur = parseLines('[00:14:55] c(次チャンク版・捨てる)\n[00:15:02] d');
  eq(joinAtBoundary(acc, cur, 900).map((l) => l.body), ['a', 'd'], '境界で振り分け');
}

console.log('mergeChunks');
{
  const chunks = [
    { nominalStart: 0, lines: parseLines('[00:00:01] 一つ目。\n[00:14:50] 二つ目の終わり際。') },
    { nominalStart: 900, lines: parseLines('[00:14:50] 二つ目の終わり際。\n[00:15:30] 三つ目。\n[00:29:55] 四つ目。') },
    { nominalStart: 1800, lines: parseLines('[00:29:55] 四つ目。\n[00:30:10] 五つ目。') },
  ];
  eq(serializeLines(mergeChunks(chunks)),
    '[00:00:01] 一つ目。\n[00:14:50] 二つ目の終わり際。\n[00:15:30] 三つ目。\n[00:29:55] 四つ目。\n[00:30:10] 五つ目。',
    '3チャンクが重複なく結合される');
  eq(mergeChunks([{ nominalStart: 0, lines: [] }, { nominalStart: 900, lines: parseLines('[00:15:00] x') }]).length, 1, '空チャンクがあっても動く');
}
eq(stripTimestamps('[00:01:00] a\n[02:03] b\nc'), 'a\nb\nc', 'stripTimestamps');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
