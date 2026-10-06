# APNG 逐帧检查器（本地）

定位动画贴纸逐帧覆盖时的清理残影：逐帧把局部矩形覆盖到画布上时，`dispose_op` 的
NONE / BACKGROUND / PREVIOUS 处理稍有偏差就会留下错误残影。本工具把每一帧的
**帧前、展示后、清理后** 三张画布并排展示，让制作者看清残影出现在哪一步清理。

全部解析在浏览器本地完成，文件不上传。

## 运行

```bash
docker compose up        # http://localhost:8080
```

无 Docker 时任意静态服务器均可：`cd site && python3 -m http.server 8080`。

## 测试

```bash
npm test                 # node --test tests/（44 个用例，无外部依赖）
```

## 约束（载入即校验，违反即报错，绝不回退为静态图静默显示）

- RGBA8（位深 8、颜色类型 6）、非隔行、无颜色管理扩展块（gAMA/cHRM/sRGB/iCCP/sBIT）
- 画布 ≤ 64×64，帧数 ≤ 16，文件 ≤ 64 KiB
- 块白名单：IHDR / acTL / fcTL / IDAT / fdAT / IEND 及少量无害元数据块

## 校验内容

- 真实逐块解析：PNG 签名、块长度不越界、每块 CRC-32
- 结构规则：单一 IHDR、IDAT 连续、acTL 在首个 IDAT 之前、IEND 后无垃圾数据
- acTL 声明帧数 == 实际 fcTL 个数；fcTL/fdAT 共享序号从 0 连续递增
- fcTL 矩形不越画布、dispose_op ≤ 2、blend_op ≤ 1、delay_den=0 按 100 处理
- 区分默认图是否属于动画（首个 fcTL 在首个 IDAT 之前 ⇒ 默认图即第一帧，且必须覆盖全画布）

## 合成语义（自行实现，未委托现成播放器）

- 普通 PNG 解码的 inflate 用平台成熟实现（浏览器 `DecompressionStream` / Node `zlib`），
  行滤波还原为自有代码；APNG 的混合与清理完全自实现
- `blend_op`：SOURCE 直接覆盖（含 alpha）；OVER 按规范源-over 公式合成
- `dispose_op`：NONE 不动；BACKGROUND 清空帧矩形；
  PREVIOUS 恢复**当前帧绘制之前**的画布（不是上一帧的展示图）
- 首帧按规范自然成立：画布初始全透明，OVER 等价 SOURCE，PREVIOUS 等价 BACKGROUND
- 载入时一次性预计算全部帧的三阶段快照，前进 / 后退 / 跳转只读快照——
  任何访问顺序像素都一致，不做实时播放

## 页面功能

- 块列表（偏移 / 类型 / 长度 / CRC）、帧列表（矩形 / 延迟 / dispose / blend / 数据来源）
- 上一帧 / 下一帧 / 跳到任意帧（按钮、输入框、点击帧表行、←/→ 键）
- 帧前、展示后、清理后三画布 + 当前帧源图（局部矩形），指针悬停读像素 RGBA
- 下载当前合成帧 PNG（完整画布的合成结果，不是原始局部图）
- 静态 PNG（无 acTL）如实提示并仅显示图像；坏文件只报错不渲染

## 目录

```
compose.yaml          # nginx 托管静态页面
site/                 # 纯静态页面，零依赖 ES modules
  js/png-chunks.js    # 块解析与校验
  js/apng.js          # acTL/fcTL/fdAT 组装
  js/png-decode.js    # inflate + 行滤波还原
  js/compositor.js    # SOURCE/OVER 混合、NONE/BACKGROUND/PREVIOUS 清理
  js/png-encode.js    # 合成帧 → PNG（下载）
  js/sample.js        # 内置示例 APNG 生成
tests/                # node:test 单元 + 集成测试
```
