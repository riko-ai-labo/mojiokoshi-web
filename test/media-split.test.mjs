// 実行方法: node test/media-split.test.mjs   （ffmpeg / ffprobe が PATH にあること）
// 180秒（100〜101秒だけビープ音、他は無音）のファイルを各形式で生成し、
// analyzeMedia が正しい長さを返し、slice() が正しい時間範囲を切り出せるかを検証する。
import { execFileSync, spawnSync } from 'node:child_process';
import { openAsBlob, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeMedia, planChunks } from '../js/media-split.js';

const DIR = join(process.env.SCRATCH_DIR || tmpdir(), 'mojiokoshi-fixtures');
mkdirSync(DIR, { recursive: true });

let passed = 0;
let failed = 0;
function check(cond, label, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok: ${label}`);
  } else {
    failed++;
    console.error(`  NG: ${label} ${extra}`);
  }
}

const SRC_FILTER = "aevalsrc='if(between(t,100,101),0.8*sin(2*PI*880*t),0)':s=44100:d=180";

function ffmpeg(args) {
  return execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
}
function ffprobeDuration(path) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8' });
  return Number(out.trim());
}
/** 指定区間の平均音量(dB)。無音は -90 前後、ビープは -10 前後 */
function meanVolume(path, from, to) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', path, '-af', `atrim=${from}:${to},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : NaN;
}
/** 生ADTSはffprobeが長さをビットレート推定するため、一度WAVにデコードしてから測る */
function decodedDuration(path) {
  const wav = path + '.decoded.wav';
  ffmpeg(['-i', path, '-c:a', 'pcm_s16le', wav]);
  return ffprobeDuration(wav);
}
function decodeErrors(path) {
  try {
    return execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return String(e.stderr || e.message);
  }
}

const fixtures = [
  { name: 'cbr.mp3', args: ['-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', 'title=テスト', '-id3v2_version', '3'] },
  { name: 'vbr.mp3', args: ['-c:a', 'libmp3lame', '-q:a', '5'] },
  { name: 'mono22k.mp3', args: ['-c:a', 'libmp3lame', '-ar', '22050', '-ac', '1', '-b:a', '48k'] },
  { name: 'audio.m4a', args: ['-c:a', 'aac', '-b:a', '128k'] },
  { name: 'audio-he.m4a', args: ['-c:a', 'aac', '-profile:a', 'aac_low', '-ar', '48000', '-ac', '1', '-b:a', '64k'] },
  { name: 'video-faststart.mp4', video: true, args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'] },
  { name: 'video-moov-last.mp4', video: true, args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k'] },
  { name: 'video.mov', video: true, args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '96k'] },
  { name: 'audio.wav', args: ['-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1'] },
];

for (const f of fixtures) {
  const path = join(DIR, f.name);
  if (!existsSync(path)) {
    const inputs = f.video
      ? ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=180', '-f', 'lavfi', '-i', SRC_FILTER, '-shortest']
      : ['-f', 'lavfi', '-i', SRC_FILTER];
    ffmpeg([...inputs, ...f.args, path]);
  }
}

for (const f of fixtures) {
  console.log(f.name);
  const path = join(DIR, f.name);
  const blob = await openAsBlob(path);
  const file = new File([blob], f.name);
  const media = await analyzeMedia(file);
  check(!!media, '解析できる');
  if (!media) continue;
  const realDur = ffprobeDuration(path);
  check(Math.abs(media.duration - realDur) < 1.0, `長さ ${media.duration.toFixed(2)}s ≒ ffprobe ${realDur.toFixed(2)}s`);

  // 90〜110秒を切り出す → 長さ約20秒、ビープは切り出し後の10〜11秒に現れる
  const part = await media.slice(90, 110);
  const outPath = join(DIR, `${f.name}.part.${media.ext}`);
  writeFileSync(outPath, Buffer.from(await part.arrayBuffer()));
  const errs = decodeErrors(outPath).trim();
  check(!errs, 'ffmpegがエラーなくデコードできる', errs.slice(0, 200));
  const d = decodedDuration(outPath);
  check(Math.abs(d - 20) < 1.5, `切り出し長 ${d.toFixed(2)}s ≒ 20s`);
  const beep = meanVolume(outPath, 10, 11);
  const quiet = meanVolume(outPath, 2, 8);
  check(beep > quiet + 30, `ビープが10〜11秒に存在（beep=${beep}dB, quiet=${quiet}dB）`);

  // 末尾をまたぐ範囲、先頭範囲もエラーにならない
  const tail = await media.slice(170, 999);
  check(tail.size > 0, '末尾を超える範囲も切り出せる');
  const head = await media.slice(0, 5);
  check(head.size > 0 && head.size < part.size, '先頭範囲は短い');
  // 1分あたりの音声サイズ（動画でも音声だけが取り出せているか）
  const perMin = (part.size / 20) * 60 / 1024 / 1024;
  check(perMin < 3 || media.kind === 'wav', `音声のみ: ${perMin.toFixed(2)} MB/分`);
}

console.log('planChunks');
{
  const one = planChunks(600, 900, 30);
  check(one.length === 1 && one[0].audioEnd === 600, '短いファイルは1チャンク');
  const many = planChunks(3 * 3600, 900, 30);
  check(many.length === 12, '3時間は12チャンク');
  check(many[1].audioStart === 870 && many[1].audioEnd === 1830, '2番目は前後30秒のりしろ付き');
  check(many[0].audioStart === 0 && many[11].audioEnd === 10800, '先頭と末尾はファイル範囲内');
  const stub = planChunks(900 + 20, 900, 30);
  check(stub.length === 1 && stub[0].nominalEnd === 920, '短すぎる末尾は吸収される');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
