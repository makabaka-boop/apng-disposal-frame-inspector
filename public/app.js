import {
  ApngError,
  decodePngInBrowser,
  exportImageDataBlob,
  inspectApng,
  MAX_DIMENSION,
  MAX_FILE_BYTES,
  MAX_FRAMES,
} from './apng.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  result: null,
  file: null,
  currentFrame: 0,
};

const elements = {
  fileInput: $('#file-input'),
  dropZone: $('#drop-zone'),
  status: $('#status'),
  error: $('#error'),
  fileMeta: $('#file-meta'),
  timeline: $('#timeline'),
  info: $('#frame-info'),
  navigation: $('#navigation'),
  frameSelect: $('#frame-select'),
  previousFrame: $('#previous-frame'),
  nextFrame: $('#next-frame'),
  download: $('#download-frame'),
  runTests: $('#run-tests'),
  testOutput: $('#test-output'),
  canvases: {
    source: $('#source-canvas'),
    pre: $('#pre-canvas'),
    post: $('#post-canvas'),
    cleaned: $('#cleaned-canvas'),
  },
};

const DISPOSE_NAMES = ['NONE (0)', 'BACKGROUND (1)', 'PREVIOUS (2)'];
const BLEND_NAMES = ['SOURCE (0)', 'OVER (1)'];

function setError(message) {
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

function formatBytes(length) {
  if (length >= 1024) {
    return `${length} B（${(length / 1024).toFixed(2)} KiB）`;
  }
  return `${length} B`;
}

function renderImageData(canvas, imageData) {
  const scale = 8;
  canvas.width = imageData.width * scale;
  canvas.height = imageData.height * scale;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;

  const source = document.createElement('canvas');
  source.width = imageData.width;
  source.height = imageData.height;
  source.getContext('2d').putImageData(imageData, 0, 0);

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
}

function makeCanvasImageData(width, height, data) {
  return new ImageData(new Uint8ClampedArray(data), width, height);
}

function clearCanvases() {
  for (const canvas of Object.values(elements.canvases)) {
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext('2d').clearRect(0, 0, 1, 1);
  }
}

function renderFrame() {
  const { result, currentFrame } = state;
  if (!result) {
    return;
  }

  const frame = result.timeline[currentFrame];
  const snapshots = result.states[currentFrame];
  const { control, bitmap } = frame;

  renderImageData(
    elements.canvases.source,
    new ImageData(
      new Uint8ClampedArray(bitmap.data),
      control.width,
      control.height,
    ),
  );
  renderImageData(
    elements.canvases.pre,
    makeCanvasImageData(result.width, result.height, snapshots.pre),
  );
  renderImageData(
    elements.canvases.post,
    makeCanvasImageData(result.width, result.height, snapshots.post),
  );
  renderImageData(
    elements.canvases.cleaned,
    makeCanvasImageData(result.width, result.height, snapshots.cleaned),
  );

  elements.frameSelect.value = String(currentFrame);
  elements.previousFrame.disabled = currentFrame === 0;
  elements.nextFrame.disabled = currentFrame === result.timeline.length - 1;

  const sequenceText = control.sequenceNumber === null
    ? '不适用（普通 PNG）'
    : control.sequenceNumber;
  const defaultText = result.isAnimated
    ? (result.defaultImage.inAnimation
      ? '是：默认 IDAT 图是时间轴第一帧'
      : '否：默认 IDAT 图仅为兼容静态图；时间轴第一帧来自 fdAT')
    : '普通 PNG，没有 acTL';

  elements.info.innerHTML = `
    <tr><th>当前帧</th><td>${currentFrame + 1} / ${result.timeline.length}</td></tr>
    <tr><th>图像数据</th><td>${frame.encoding}；连续序号 ${sequenceText}</td></tr>
    <tr><th>默认图是否属于动画</th><td>${defaultText}</td></tr>
    <tr><th>局部矩形</th><td>${control.width}×${control.height} @ (${control.xOffset}, ${control.yOffset})</td></tr>
    <tr><th>合成 blend_op</th><td>${BLEND_NAMES[control.blendOp] ?? control.blendOp}</td></tr>
    <tr><th>清理 dispose_op</th><td>${DISPOSE_NAMES[control.disposeOp] ?? control.disposeOp}</td></tr>
    <tr><th>延迟</th><td>${control.delayNumerator}/${control.delayDenominator} s（约 ${control.delayMs.toFixed(1)} ms；本页不播放）</td></tr>
  `;
}

function renderMetadata() {
  const { result, file } = state;
  if (!result) {
    elements.status.textContent = '尚未载入文件。选择本地 APNG 后进行严格校验；文件只在浏览器内读取。';
    elements.fileMeta.innerHTML = '';
    elements.timeline.innerHTML = '';
    elements.info.innerHTML = '';
    elements.navigation.hidden = true;
    elements.download.disabled = true;
    return;
  }

  elements.status.textContent = result.isAnimated
    ? '校验通过：识别为 APNG，已按规范从初始透明画布逐步合成。'
    : '校验通过：这是普通 PNG（无 acTL），按单帧静态图检查。';
  setError('');

  const defaultMembership = !result.isAnimated
    ? '不适用'
    : (result.defaultImage.inAnimation
      ? '属于动画（第一帧使用 IDAT）'
      : '不属于动画（仅静态兼容图，第一帧在 fdAT）');

  elements.fileMeta.innerHTML = `
    <tr><th>文件</th><td>${escapeHtml(file?.name ?? '内存数据')}，${formatBytes(file?.size ?? 0)}</td></tr>
    <tr><th>画布</th><td>${result.width}×${result.height} RGBA8，非隔行</td></tr>
    <tr><th>类型</th><td>${result.isAnimated ? `APNG；acTL 帧数 ${result.animation.frameCount}；播放次数 ${result.animation.playCount}` : '普通 PNG'}</td></tr>
    <tr><th>默认图</th><td>${defaultMembership}</td></tr>
    <tr><th>块数量</th><td>${result.chunks.length}；每块长度和 CRC 已核对</td></tr>
  `;

  elements.timeline.innerHTML = result.chunks.map((chunk) => {
    const sequence = chunk.sequence === null || chunk.sequence === undefined
      ? ''
      : `<span class="sequence">序号 ${chunk.sequence}</span>`;
    return `<li><code>${chunk.type}</code><span>偏移 ${chunk.offset}，长度 ${chunk.length}</span>${sequence}</li>`;
  }).join('');

  elements.frameSelect.innerHTML = result.timeline
    .map((frame, index) => `<option value="${index}">第 ${index + 1} 帧</option>`)
    .join('');
  elements.navigation.hidden = false;
  elements.download.disabled = false;
  renderFrame();
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

async function loadFile(file) {
  if (!file) {
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    state.result = null;
    state.file = null;
    clearCanvases();
    renderMetadata();
    setError(`${file.name} 为 ${file.size} 字节，超过 ${MAX_FILE_BYTES} 字节（64 KiB）限制；未进行解析。`);
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await inspectApng(bytes, decodePngInBrowser);
    state.result = result;
    state.file = file;
    state.currentFrame = 0;
    renderMetadata();
  } catch (error) {
    state.result = null;
    state.file = file;
    clearCanvases();
    renderMetadata();
    const message = error instanceof ApngError
      ? error.message
      : `浏览器 PNG 解码器失败：${error.message}`;
    setError(`${file.name}：${message}。不会把坏块文件悄悄当作静态 PNG 降级。`);
  }
}

elements.fileInput.addEventListener('change', (event) => {
  loadFile(event.target.files?.[0]);
});

elements.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.dropZone.classList.add('dragover');
});
elements.dropZone.addEventListener('dragleave', () => {
  elements.dropZone.classList.remove('dragover');
});
elements.dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove('dragover');
  loadFile(event.dataTransfer.files?.[0]);
});

elements.previousFrame.addEventListener('click', () => {
  if (state.currentFrame > 0) {
    state.currentFrame -= 1;
    renderFrame();
  }
});
elements.nextFrame.addEventListener('click', () => {
  if (state.result && state.currentFrame < state.result.timeline.length - 1) {
    state.currentFrame += 1;
    renderFrame();
  }
});
elements.frameSelect.addEventListener('change', (event) => {
  state.currentFrame = Number(event.target.value);
  renderFrame();
});

elements.download.addEventListener('click', async () => {
  const { result, currentFrame, file } = state;
  if (!result) {
    return;
  }

  const snapshot = result.states[currentFrame].post;
  const blob = await exportImageDataBlob({
    width: result.width,
    height: result.height,
    data: snapshot,
  });

  const baseName = (file?.name ?? 'frame').replace(/\.png$/i, '');
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${baseName || 'apng'}_composite_frame_${String(currentFrame + 1).padStart(2, '0')}.png`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
});

elements.runTests.addEventListener('click', async () => {
  elements.runTests.disabled = true;
  elements.testOutput.textContent = '正在运行内置自检……';
  try {
    const { runSelfTests } = await import('./self_test.js');
    const messages = await runSelfTests();
    elements.testOutput.innerHTML = `<strong class="ok">通过</strong><ul>${
      messages.map((message) => `<li>${escapeHtml(message)}</li>`).join('')
    }</ul>`;
  } catch (error) {
    elements.testOutput.innerHTML = `<strong class="fail">失败：${escapeHtml(error.message)}</strong>`;
  } finally {
    elements.runTests.disabled = false;
  }
});

renderMetadata();
