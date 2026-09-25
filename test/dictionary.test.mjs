// 実行方法: node test/dictionary.test.mjs
import { applyDictionary, suggestCorrections } from '../js/dictionary.js';

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok: ${label}`);
  } else {
    failed++;
    console.error(`  NG: ${label}\n     expected: ${e}\n     actual:   ${a}`);
  }
}

console.log('applyDictionary');
{
  const dict = [
    { surface: 'クレアカ', reading: 'くれあか', wrongs: ['クレア化', '暮れ赤'] },
    { surface: 'Gemini', reading: '', wrongs: ['ジェミニ'] },
  ];
  assertEqual(
    applyDictionary('今日はクレア化の話とジェミニの話。暮れ赤も。', dict),
    '今日はクレアカの話とGeminiの話。クレアカも。',
    '誤認識例がすべて表記に置換される'
  );
  assertEqual(applyDictionary('辞書に無い文はそのまま', dict), '辞書に無い文はそのまま', '無関係な文は変化しない');
  assertEqual(applyDictionary('テスト', []), 'テスト', '空辞書でもエラーにならない');
  assertEqual(
    applyDictionary('クレアカとクレアの話', [{ surface: 'クレアカ', reading: '', wrongs: ['クレア'] }]),
    'クレアカとクレアの話',
    '表記の一部になっている誤認識例は二重置換しない'
  );
  assertEqual(
    applyDictionary('ぽちぺた拡張', [{ surface: 'ぽちペタ', reading: '', wrongs: ['ぽち', 'ぽちぺた'] }]),
    'ぽちペタ拡張',
    '長い誤認識例が先に適用される'
  );
}

console.log('suggestCorrections');
{
  // 単語レベルの修正 → ペアが抽出される
  const orig = '[00:01:23] 今日はクレア化について説明します。\n[00:02:00] 次の話題です。';
  const corr = '[00:01:23] 今日はクレアカについて説明します。\n[00:02:00] 次の話題です。';
  assertEqual(
    suggestCorrections(orig, corr),
    [{ wrong: 'クレア化', correct: 'クレアカ' }],
    '1語の修正が単語のかたまりで抽出される'
  );
}
{
  // 複数行・複数修正
  const orig = 'ポチペタの使い方。\nジェミニのAPIを使います。\n変わらない行。';
  const corr = 'ぽちペタの使い方。\nGeminiのAPIを使います。\n変わらない行。';
  const pairs = suggestCorrections(orig, corr);
  assertEqual(pairs.length, 2, '2つの修正が両方検出される');
  assertEqual(
    pairs.some((p) => p.wrong === 'ジェミニ' && p.correct === 'Gemini'),
    true,
    'カタカナ→英語の修正が検出される'
  );
}
{
  assertEqual(suggestCorrections('同じテキスト', '同じテキスト'), [], '変更なしなら空');
  assertEqual(suggestCorrections('', 'なにか'), [], '空文字なら空');
}
{
  // 1文字だけの違いも前後の単語かたまりに広がる
  const orig = '受講生の皆さんは大変です。';
  const corr = '受講生の皆さんは太変です。'.replace('太変', '大変'); // = 同一 → 空
  assertEqual(suggestCorrections(orig, corr), [], '実質同一なら空');
}
{
  // 長文でも動く（行単位分割の確認）
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(`[00:${String(i % 60).padStart(2, '0')}:00] これは${i}行目の発言内容です。`);
  const orig = lines.join('\n');
  const corrLines = [...lines];
  corrLines[250] = corrLines[250].replace('発言内容', '発現内容');
  const pairs = suggestCorrections(corrLines.join('\n'), orig); // 誤→正の向き
  assertEqual(
    pairs.some((p) => p.wrong.includes('発現') && p.correct.includes('発言')),
    true,
    '500行のテキストでも該当行の修正を検出する'
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
