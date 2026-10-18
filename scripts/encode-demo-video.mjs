#!/usr/bin/env node
/**
 * EmbedDesk 演示视频编码（record-demo-video.mjs 的下一步）
 *
 * 读取 .video-demo/frame-ts.json 的每帧时间戳，生成 ffmpeg concat  demuxer
 * 清单（VFR 真实节奏），再统一转换为 30fps CFR 的 H.264 MP4（yuv420p 兼容全部播放器）。
 *
 * ffmpeg 来源（按优先级）：环境变量 FFMPEG_BIN → imageio-ffmpeg（PyPI 安装）→ PATH
 *
 * 运行：node scripts/encode-demo-video.mjs [输出路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.video-live');
const FRAMES = path.join(OUT_DIR, 'frames');
const TS_FILE = path.join(OUT_DIR, 'frame-ts.json');
const OUTPUT = process.argv[2] || path.join(ROOT, 'embeddesk-demo.mp4');

function findFfmpeg() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  const pyPath = 'C:/Users/HONOR/.workbuddy/binaries/python/envs/default/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe';
  if (fs.existsSync(pyPath)) return pyPath;
  return 'ffmpeg';
}

function main() {
  if (!fs.existsSync(TS_FILE)) {
    console.error('[encode] 缺少 frame-ts.json，请先运行 record-demo-video.mjs');
    process.exit(1);
  }
  const frames = JSON.parse(fs.readFileSync(TS_FILE, 'utf8'));
  if (frames.length < 2) {
    console.error('[encode] 帧数不足');
    process.exit(1);
  }

  // ---- 生成 concat 清单（每帧 duration = 与下一帧的时间差；首帧给 1/30，末帧 1/15）----
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const filePath = path.join(FRAMES, f.name).replace(/\\/g, '/');
    lines.push(`file '${filePath}'`);
    let dur;
    if (i === frames.length - 1) dur = 1 / 15;
    else {
      dur = frames[i + 1].ts - f.ts;
      dur = Math.min(Math.max(dur, 0.001), 0.5); // 钳制：防 0/负值与场景断裂
    }
    lines.push(`duration ${dur.toFixed(4)}`);
  }
  const listPath = path.join(OUT_DIR, 'frames.txt');
  fs.writeFileSync(listPath, lines.join('\n') + '\n');

  const ffmpeg = findFfmpeg();
  const span = frames[frames.length - 1].ts - frames[0].ts;
  console.log(`[encode] ${frames.length} 帧，时间跨度 ${span.toFixed(1)}s`);
  console.log(`[encode] ffmpeg: ${ffmpeg}`);

  const args = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath.replace(/\\/g, '/'),
    '-vf', 'fps=30,format=yuv420p',
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'medium',
    '-movflags', '+faststart',
    '-an',
    OUTPUT.replace(/\\/g, '/'),
  ];
  execFileSync(ffmpeg, args, { stdio: 'inherit' });

  const sizeMB = (fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(1);
  console.log(`[encode] 完成：${OUTPUT}（${sizeMB} MB）`);
}

main();
