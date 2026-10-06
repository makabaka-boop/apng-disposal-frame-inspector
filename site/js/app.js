// 页面主逻辑：文件读取（仅本地，不上传）、解析、三阶段画布渲染、帧导航、下载合成帧。
import { parsePng, PngError, LIMITS } from './png-chunks.js';
import { assembleApng, DISPOSE_OPS, BLEND_OPS } from './apng.js';
import { decodePngPixels } from './png-decode.js';
import { computeFrameStates } from './compositor.js';
import { encodePngRgba } from './png-encode.js';
import { buildSampleApng } from './sample.js';

const $ = (sel) => document.querySelector(sel);

// 当前会话：解析一次、预计算全部帧状态，导航只读取快照，保证任意访问顺序像素一致。
let session = null;

function resetUi() {
  session = null;
  $('#error-box').hidden = true;
  $('#report').hidden = true;
  $('#static-box').hidden = true;
  $('#error-text').textContent = '';
}

function showError(err) {
  $('#report').hidden = true;
  $('#static-box').hidden = true;
  $('#error-box').hidden = false;
  $('#error-text').textContent = err instanceof PngError
    ? err.message
    : `未预期的错误：${err.message}`;
  if (!(err instanceof PngError)) console.error(err);
}

function delayMs(f) {
  return (f.delayNum / f.delayDen) * 1000;
}

// 把 RGBA 字节画到画布（整数倍最近邻放大，便于逐像素检查）。
const scratch = document.createElement('canvas');
function drawPixels(canvasEl, bytes, w, h, scale) {
  canvasEl.width = w * scale;
  canvasEl.height = h * scale;
  canvasEl.dataset.scale = scale;
  scratch.width = w;
  scratch.height = h;
  scratch.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(bytes), w, h), 0, 0);
  const ctx = canvasEl.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.drawImage(scratch, 0, 0, canvasEl.width, canvasEl.height);
}

function pickScale(w, h) {
  return Math.min(16, Math.max(2, Math.floor(384 / Math.max(w, h))));
}

function renderChunkTable(parsed) {
  const rows = parsed.chunks.map((c, i) =>
    `<tr><td>${i}</td><td>${c.offset}</td><td class="mono">${c.type}</td><td>${c.length}</td><td class="ok">✓</td></tr>`
  ).join('');
  $('#chunk-table tbody').innerHTML = rows;
}

function renderFrameTable(anim) {
  const rows = anim.frames.map((f) =>
    `<tr data-frame="${f.index}">
      <td>${f.index + 1}</td>
      <td>(${f.x}, ${f.y})</td>
      <td>${f.width}×${f.height}</td>
      <td>${delayMs(f).toFixed(0)} ms</td>
      <td>${DISPOSE_OPS[f.dispose]}</td>
      <td>${BLEND_OPS[f.blend]}</td>
      <td>${f.fromIdat ? 'IDAT（默认图）' : 'fdAT'}</td>
      <td>${f.compressed.length}</td>
    </tr>`
  ).join('');
  $('#frame-table tbody').innerHTML = rows;
  $('#frame-table tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-frame]');
    if (tr) showFrame(Number(tr.dataset.frame));
  });
}

function showFrame(index) {
  if (!session) return;
  const n = session.states.length;
  const i = ((index % n) + n) % n; // 越界回绕，任意跳转都安全
  session.index = i;
  const { width, height, scale } = session;
  const state = session.states[i];
  const frame = session.anim.frames[i];

  drawPixels($('#canvas-before'), state.before, width, height, scale);
  drawPixels($('#canvas-display'), state.display, width, height, scale);
  drawPixels($('#canvas-after'), state.after, width, height, scale);
  drawPixels($('#canvas-raw'), frame.pixels, frame.width, frame.height, scale);

  $('#frame-indicator').textContent = `第 ${i + 1} / ${n} 帧`;
  $('#frame-jump').value = i + 1;
  $('#frame-meta').textContent =
    `矩形 (${frame.x}, ${frame.y}) ${frame.width}×${frame.height} · ` +
    `blend=${BLEND_OPS[frame.blend]} · dispose=${DISPOSE_OPS[frame.dispose]} · ` +
    `延迟 ${delayMs(frame).toFixed(0)} ms`;

  document.querySelectorAll('#frame-table tbody tr').forEach((tr) => {
    tr.classList.toggle('current', Number(tr.dataset.frame) === i);
  });
  $('#pixel-readout').textContent = '将指针移到画布上查看像素';
}

async function handleBytes(bytes, sourceName) {
  resetUi();
  try {
    const parsed = parsePng(bytes);
    const { ihdr } = parsed;
    const anim = assembleApng(parsed);

    $('#file-info').innerHTML =
      `<dt>来源</dt><dd>${sourceName}（${bytes.length} 字节，未上传，仅本地解析）</dd>` +
      `<dt>画布</dt><dd>${ihdr.width}×${ihdr.height} RGBA8 非隔行</dd>`;
    renderChunkTable(parsed);

    if (!anim.isAnimated) {
      // 静态 PNG：如实告知，不伪装成动画，也不在此提供帧操作。
      const pixels = await decodePngPixels(anim.defaultImageCompressed, ihdr.width, ihdr.height);
      $('#static-box').hidden = false;
      drawPixels($('#canvas-static'), pixels, ihdr.width, ihdr.height, pickScale(ihdr.width, ihdr.height));
      $('#report').hidden = false;
      $('#animation-section').hidden = true;
      return;
    }

    for (const f of anim.frames) {
      f.pixels = await decodePngPixels(f.compressed, f.width, f.height);
    }
    let defaultPixels = null;
    if (anim.defaultImageCompressed) {
      defaultPixels = await decodePngPixels(anim.defaultImageCompressed, ihdr.width, ihdr.height);
    }

    const states = computeFrameStates(anim.frames, ihdr.width, ihdr.height);
    session = {
      parsed, anim, states,
      width: ihdr.width, height: ihdr.height,
      scale: pickScale(ihdr.width, ihdr.height),
      index: 0,
    };

    $('#file-info').innerHTML +=
      `<dt>动画</dt><dd>${anim.frames.length} 帧 · 循环 ${anim.numPlays === 0 ? '∞' : anim.numPlays + ' 次'}</dd>` +
      `<dt>默认图</dt><dd>${anim.defaultInAnimation
        ? '属于动画（首帧来自 IDAT）'
        : '不属于动画（IDAT 为静态回退图，动画从全透明画布开始）'}</dd>`;

    renderFrameTable(anim);
    $('#animation-section').hidden = false;
    $('#default-image-block').hidden = anim.defaultInAnimation;
    if (defaultPixels) {
      drawPixels($('#canvas-default'), defaultPixels, ihdr.width, ihdr.height, session.scale);
    }
    $('#frame-jump').max = anim.frames.length;
    $('#report').hidden = false;
    showFrame(0);
  } catch (err) {
    showError(err);
  }
}

async function handleFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await handleBytes(bytes, file.name);
}

// 像素读数：显示指针所在像素在三个阶段画布中的 RGBA。
function attachPixelReadout(canvasEl) {
  canvasEl.addEventListener('mousemove', (e) => {
    if (!session) return;
    const scale = Number(canvasEl.dataset.scale);
    const rect = canvasEl.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / scale);
    const y = Math.floor((e.clientY - rect.top) / scale);
    if (x < 0 || y < 0 || x >= session.width || y >= session.height) return;
    const state = session.states[session.index];
    const parts = [];
    const read = (bytes, label) => {
      const i = (y * session.width + x) * 4;
      parts.push(`${label} rgba(${bytes[i]}, ${bytes[i + 1]}, ${bytes[i + 2]}, ${bytes[i + 3]})`);
    };
    read(state.before, '帧前');
    read(state.display, '展示后');
    read(state.after, '清理后');
    $('#pixel-readout').textContent = `(${x}, ${y}) ${parts.join(' · ')}`;
  });
}

async function downloadCurrentFrame() {
  if (!session) return;
  const i = session.index;
  const png = await encodePngRgba(session.width, session.height, session.states[i].display);
  const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `frame-${String(i + 1).padStart(2, '0')}-composed.png`;
  a.click();
  URL.revokeObjectURL(url);
}

function init() {
  $('#constraint-note').textContent =
    `约束：RGBA8 · 非隔行 · 无颜色管理扩展 · 画布 ≤ ${LIMITS.MAX_DIMENSION}×${LIMITS.MAX_DIMENSION} · ` +
    `≤ ${LIMITS.MAX_FRAMES} 帧 · 文件 ≤ 64 KiB`;

  const input = $('#file-input');
  input.addEventListener('change', () => input.files[0] && handleFile(input.files[0]));

  const drop = $('#drop-zone');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('hover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('hover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  $('#btn-sample').addEventListener('click', async () => {
    const bytes = await buildSampleApng();
    await handleBytes(bytes, '内置示例（内存生成）');
  });

  $('#btn-prev').addEventListener('click', () => session && showFrame(session.index - 1));
  $('#btn-next').addEventListener('click', () => session && showFrame(session.index + 1));
  $('#btn-jump').addEventListener('click', () => session && showFrame(Number($('#frame-jump').value) - 1));
  $('#frame-jump').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && session) showFrame(Number($('#frame-jump').value) - 1);
  });
  document.addEventListener('keydown', (e) => {
    if (!session || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') showFrame(session.index - 1);
    if (e.key === 'ArrowRight') showFrame(session.index + 1);
  });
  $('#btn-download').addEventListener('click', downloadCurrentFrame);

  attachPixelReadout($('#canvas-before'));
  attachPixelReadout($('#canvas-display'));
  attachPixelReadout($('#canvas-after'));
}

init();
