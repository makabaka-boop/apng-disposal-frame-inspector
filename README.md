# 本地 APNG 贴纸检查页

一个只托管静态文件的 Docker Compose 页面，用来逐帧检查 APNG 贴纸的局部矩形、透明合成和清理残影。文件只在浏览器中读取，没有上传接口。

## 启动

```bash
docker compose up --build
# 打开 http://127.0.0.1:8080
```

停止：

```bash
docker compose down
```

也可以用任意静态服务器发布 `public/` 目录，但请保留同源静态部署方式，不要把文件发送到后端。

## 接受的文件

检查器严格要求：

- PNG 签名、每个真实块的声明长度和 CRC 都正确；
- IHDR：RGBA8（bit depth 8、colour type 6）、非隔行、PNG filter/compression 方法为 0；
- 画布宽高均不超过 64；
- `acTL` 帧数不超过 16；
- 文件不超过 64 KiB；
- 不允许颜色管理扩展块：`cHRM`、`gAMA`、`iCCP`、`sRGB`、`mDCv`、`cLLi`；
- RGBA8 下不允许 `tRNS`，未知关键块直接失败；
- `acTL/fcTL/IDAT/fdAT` 的块顺序和连续序号必须符合 APNG 规范。

普通、无 `acTL` 且 CRC/IHDR 合法的 PNG 会明确显示为“普通 PNG”单帧；带有坏长度、坏 CRC 或坏动画序号的文件会报错，不会悄悄用静态默认图降级。

## 合成模型

时间轴从全透明黑色画布开始。每一帧记录三个独立快照：

1. **帧前画布（PRE）**：当前帧绘制之前的完整画布。
2. **展示后画布（POST）**：按当前帧矩形执行 `SOURCE` 或 `OVER` 后的展示结果。
3. **清理后画布（CLEANED）**：执行 `NONE`、`BACKGROUND` 或 `PREVIOUS` 后传给下一帧的状态。

关键点：`PREVIOUS` 恢复的是当前帧绘制前的矩形，不是上一帧展示图。首帧的 `PREVIOUS` 因此恢复到规范规定的初始透明画布；若首帧矩形不是完整画布，矩形外仍保持初始透明。页面预先计算所有帧快照，前进、后退或跳到任意帧只是读取同一快照，不会因访问顺序产生不同像素。

APNG 时间轴合成由 `public/apng.js` 自行完成；每一帧只把 `fdAT` 数据重新包装成普通单帧 PNG，再交给浏览器成熟 PNG 解码器读取像素。页面不使用现成 APNG 播放器。

“下载当前合成帧”导出的是 POST 完整画布，不是当前局部原始帧。

## 自检

页面中有“运行独立像素与真实文件自检”按钮，会验证：

- 透明 `OVER` 与 `SOURCE` 覆盖；
- 连续 `PREVIOUS` 是否错误引用上一帧展示图；
- 任意前进、后退、乱序跳转后的像素一致性；
- 在浏览器内生成真实 PNG/APNG 字节，再实际走结构解析、PNG 解码和 PNG 导出往返；
- CRC 坏块、`fdAT` 序号断裂均拒绝解析。

命令行也提供不依赖浏览器的真实 PNG/APNG 结构测试和独立像素数组测试：

```bash
node test/node_selftest.mjs
```

## 文件

- `public/index.html`、`public/app.js`、`public/styles.css`：检查页；
- `public/apng.js`：PNG 块解析、CRC/序号校验和手工 APNG 合成；
- `public/self_test.js`：浏览器内自检；
- `nginx.conf`：只读静态托管和严格 CSP；
- `docker-compose.yml`：本地 Compose 托管；
- `test/node_selftest.mjs`：Node 侧结构与小像素数组测试。
