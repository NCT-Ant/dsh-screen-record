# dsh-screen-record

让 Agent 直接录屏、截屏的 DeepSeek Harness 插件。纯 ESM、零依赖、无安装脚本，底层调用本机 `ffmpeg` 的 `gdigrab` 抓桌面。

> **下载安装**：打好的包在 [Releases](https://github.com/NCT-Ant/dsh-screen-record/releases/latest) 里，文件名形如 `dsh-screen-record-1.0.0.zip`。解压到目录后，在 Harness 插件管理器里把**那个目录**当作本地 bundle 安装；装完按一次 `Ctrl+R` 刷新界面。装之前先把 `ffmpeg.exe` 准备好（见下方「准备 ffmpeg」）。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `screen_record` | 录制固定时长（默认 10 秒，上限 600 秒），阻塞到文件写完后返回 MP4 路径、首帧封面 PNG、时长、体积、分辨率、编码器 |
| `screen_record_control` | 长录制：`start` 后台开始并返回 id，`stop` 收尾并返回文件，`status` 列出进行中的录制 |
| `screenshot` | 抓一帧 PNG，可配合 `read_image` 让模型直接看到屏幕内容 |

共同能力：

- **区域**：`region` 支持 `full`（整屏）、`title=<窗口标题>`（单个窗口）、`x,y,width,height`（矩形区域）。
- **音频**：默认静音；`audio: true` 自动挑第一个 DirectShow 录音设备，也可直接传设备名。
- **缩放**：`scale` 只给宽度，高度按比例自动取偶数。
- **输出路径**：`output` 可指定，默认写到 `%USERPROFILE%\.dsh\screen-recorder\recordings\`。
- **编码**：有 `libx264` 时用 H.264 + `+faststart`；否则回退 `mpeg4`。

## 准备 ffmpeg

插件本身不打包 ffmpeg（单文件约 105 MB，进仓库会撑爆）。任选一种：

1. **自动放置（推荐）**：下载 [ffmpeg release essentials](https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip)，解压后把 `bin\ffmpeg.exe`（可选 `ffprobe.exe`）拷到
   `%USERPROFILE%\.dsh\screen-recorder\bin\`，插件默认就去这里找。
2. **显式指定**：把 `DSH_FFMPEG_PATH` 环境变量指向 `ffmpeg.exe`，或在调用工具时传 `ffmpeg: "C:\\path\\ffmpeg.exe"`。
3. **已在 PATH**：装过 ffmpeg 且 `ffmpeg -version` 能用即可。

需要带 H.264 的版本（gyan.dev 的 essentials 已含 `libx264`）；没有 `libx264` 时插件会回退到 `mpeg4`，画质差一些但能用。

## ffmpeg 查找顺序

1. 工具参数 `ffmpeg`（显式路径）
2. 环境变量 `DSH_FFMPEG_PATH`
3. 插件包内 `bin/ffmpeg.exe`
4. `%USERPROFILE%\.dsh\screen-recorder\bin\ffmpeg.exe`
5. `PATH` 上的 `ffmpeg`

## 为什么不用 Windows「截图工具」录屏

Windows 11 的截图工具（Snipping Tool / ScreenSketch）确实带录屏，但它只有 `Win+Shift+R` 这种交互式入口：开始后必须由人点停止，没有稳定可脚本化的命令行接口，也不返回文件路径。要让 Agent 无人值守地录屏，必须用可编程的采集器，因此本插件用 ffmpeg 的 `gdigrab`。截图工具仍然可以手工使用，两者互不冲突。

## 安装

```bash
plugin_manager install_bundle  target=C:\path\to\dsh-screen-record
```

安装后在插件列表里启用 `dsh-screen-record` 即可，无需重启（新 bundle 走 HMR 激活）。

## 已知限制

- 仅 Windows。
- `gdigrab` 抓的是桌面像素，硬件加密播放（受保护内容）会录成黑屏；独占全屏游戏可能抓不到。
- 录制期间的鼠标光标是否入画由 `drawMouse` 决定，默认画。
- 长录制进程保存在插件实例内存里；插件重载会丢失未收尾的录制（进程会被清理）。
- 生成的文件体积取决于时长、分辨率与帧率，长时间录制请降低 `fps` 或加 `scale`。

## 许可

MIT © Benzalkonium chloride
