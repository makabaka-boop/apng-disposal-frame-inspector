// APNG 合成器：自行实现 SOURCE/OVER 混合与 NONE/BACKGROUND/PREVIOUS 清理，
// 不委托任何现成播放器。所有函数操作扁平 RGBA 字节数组（非预乘）。
export const DISPOSE = { NONE: 0, BACKGROUND: 1, PREVIOUS: 2 };
export const BLEND = { SOURCE: 0, OVER: 1 };

// 把帧矩形混合进画布。blendOp: 0=SOURCE 直接覆盖（含 alpha），1=OVER 源-over 合成。
export function blendRect(canvas, canvasWidth, frame, fx, fy, fw, fh, blendOp) {
  for (let row = 0; row < fh; row++) {
    let ci = ((fy + row) * canvasWidth + fx) * 4;
    let fi = row * fw * 4;
    for (let col = 0; col < fw; col++, ci += 4, fi += 4) {
      const sa = frame[fi + 3];
      if (blendOp === BLEND.SOURCE || sa === 255) {
        canvas[ci] = frame[fi];
        canvas[ci + 1] = frame[fi + 1];
        canvas[ci + 2] = frame[fi + 2];
        canvas[ci + 3] = sa;
      } else if (sa !== 0) {
        // 规范源-over：co = (Cs·αs + Cb·αb·(1−αs)) / αo，αo = αs + αb·(1−αs)
        const as = sa / 255;
        const ab = canvas[ci + 3] / 255;
        const ao = as + ab * (1 - as);
        for (let k = 0; k < 3; k++) {
          canvas[ci + k] = Math.round((frame[fi + k] * as + canvas[ci + k] * ab * (1 - as)) / ao);
        }
        canvas[ci + 3] = Math.round(ao * 255);
      }
      // sa === 0 且 OVER：源完全透明，目标保持不变
    }
  }
}

// 绘制后的清理，为下一帧准备画布。
// before 是当前帧绘制之前的画布：PREVIOUS 恢复的是它，而不是上一帧的展示图。
export function applyDispose(canvas, canvasWidth, before, fx, fy, fw, fh, disposeOp) {
  if (disposeOp === DISPOSE.NONE) return;
  for (let row = 0; row < fh; row++) {
    let i = ((fy + row) * canvasWidth + fx) * 4;
    for (let col = 0; col < fw; col++, i += 4) {
      if (disposeOp === DISPOSE.BACKGROUND) {
        canvas[i] = canvas[i + 1] = canvas[i + 2] = canvas[i + 3] = 0;
      } else { // PREVIOUS
        canvas[i] = before[i];
        canvas[i + 1] = before[i + 1];
        canvas[i + 2] = before[i + 2];
        canvas[i + 3] = before[i + 3];
      }
    }
  }
}

// 顺序合成全部帧，一次性预计算每帧的三个阶段快照：
//   before  —— 帧前画布（本帧绘制前）
//   display —— 展示后画布（混合完成、尚未清理）
//   after   —— 清理后画布（dispose 应用完，即下一帧的 before）
// 合成是纯函数：预计算后任意顺序访问（前进/后退/跳转）都得到相同像素。
// 首帧按规范自然成立：画布初始全透明，OVER 作用于空画布等价于 SOURCE；
// 首帧 PREVIOUS 恢复的“绘制前画布”即全透明，等价于 BACKGROUND。
export function computeFrameStates(frames, width, height) {
  const canvas = new Uint8Array(width * height * 4);
  return frames.map((f) => {
    const before = canvas.slice();
    blendRect(canvas, width, f.pixels, f.x, f.y, f.width, f.height, f.blend);
    const display = canvas.slice();
    applyDispose(canvas, width, before, f.x, f.y, f.width, f.height, f.dispose);
    const after = canvas.slice();
    return { before, display, after };
  });
}
