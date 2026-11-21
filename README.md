# DobStudio

[官方网站与下载](https://zxjc-niusile.github.io/DobStudio/)

DobStudio 是一款集 AI 语音识别、双语字幕翻译精修、声音克隆配音与原声伴奏混音于一体的现代化 Windows 桌面工作站。

## 功能

- **全流程自由组合**：支持「纯字幕转写/压制（零 GPU 依赖）」与「高保真声音克隆配音」自由选择。
- **音视频导入与识别**：支持本地音视频导入与在线视频下载，内置 whisper.cpp 极速离线转写。
- **双语翻译与字幕精修**：内置主流大模型预设（DeepSeek、OpenAI、硅基流动等），支持 SRT 导入、虚拟化长列表编辑与毫秒级视频同屏定位。
- **多引擎语音克隆**：集成 CosyVoice（阿里通义，高保真克隆、原生文本前端）与 XTTS（轻量多语言跨语种克隆）。
- **智能伴奏分离与混音**：支持可选的 Demucs 人声/伴奏分离，提供自动降鸭（Audio Ducking）与可调节伴奏音量。
- **专业级多格式交付**：支持原视频声轨、纯配音干声、配音+原片伴奏混音三种成片输出；支持字幕硬烧录与原画幅、16:9、9:16 画幅自适应适配。
- **任务管理**：排队运行、查看进度与取消任务。

## 启动与使用

需要 Node.js 22.5+ 和 npm。

```powershell
npm ci
npm run build
npm start
```

1. 在「运行设置」一键安装字幕工具（FFmpeg / yt-dlp）及 whisper.cpp base 模型。
2. 导入视频，在「字幕工作台」生成或导入字幕。翻译语言留空则仅转写；翻译可直接在设置中选用预设服务商（如 DeepSeek）。
3. 校对并保存字幕，可直接导出 SRT 或烧录成片交付。
4. 需要配音时，配置 Python 环境和模型，在「声音与配音」选择克隆引擎、伴奏分离开关与音量后提交任务。
5. 在任务记录中实时查看进度、一键定位打开成片与音频文件。

项目工程与用户配置保存在 Electron 的 DobStudio userData 目录，安装版与便携版数据统一持久化。

## 配音环境（按需安装）

字幕功能无需 Python。配音时安装所选引擎的依赖：

```powershell
# 1. 基础 PyTorch 环境（先在所选 Python 环境安装适配 CPU 或 CUDA 的 torch 与 torchaudio）

# 2. 按需安装克隆与伴奏引擎
# CosyVoice 高保真引擎
python -m pip install -r engine/requirements.txt
# XTTS 轻量跨语种引擎
python -m pip install -r engine/requirements-xtts.txt
# Demucs 背景音乐分离（如需保留原声伴奏）
python -m pip install -r engine/requirements-bgm.txt
```

CosyVoice 与 XTTS 在运行设置中分别选择本地模型目录（XTTS 目录包含 `config.json`、`model.pth`、`vocab.json`）。Demucs 在勾选伴奏分离后首次运行会按需载入权重，也可提前放置于 Torch 缓存中。

参考音频使用一段清晰、完整的 0.5–29 秒单人声 WAV，参考文本对应录音原文。单句配音超出目标区间时，可调整译文或微调字幕时间戳。

## 开发与测试

```powershell
npm run typecheck       # TypeScript 全工程静态类型检查
npm test                # Core 与 App 前端全量自动化测试
npm run test:engine     # Python 配音与媒体合成协议测试
npm run build           # 前端 Vite 产物与 Electron 编译
npm run test:editor     # Electron 窗口与字幕保存集成测试
npm run smoke           # 桌面端端到端 Smoke 检查
npm run package         # 生成 Windows NSIS 安装包与 Portable 便携版
```

测试 Electron 界面前先运行 build。打包产物位于 `app/release/`。
Python 媒体测试可通过 `DOBSTUDIO_TEST_MEDIA_BIN` 指定 ffmpeg/ffprobe 目录。

## 官网

官网源码位于 `website/dist/`，无需构建。运行 `python -m http.server 4177 --directory website/dist` 可本地预览。发布新版本时更新 `index.html` 中的版本号、下载地址与文件大小。

官网由 GitHub Pages 托管：PR 自动检查静态资源；合并到 main 后，.github/workflows/pages.yml 会发布 website/dist/。仓库 Settings → Pages 的 Source 应设为 GitHub Actions。只有官网文件变动或手动运行工作流时才部署，不构建桌面安装包。

执行 python website/check.py 检查本地资源与页面锚点。官网字体为 Noto Sans SC 的页面字符子集，许可位于 website/dist/assets/NotoSansSC-OFL.txt；新增文案后用 python website/update_fonts.py 更新字体文件（需要联网，仅维护时运行）。

## 代码结构

- `app/`：React 界面与 Electron 桌面宿主。
- `core/`：字幕、翻译、下载、项目存储和任务调度。
- `engine/`：Python 配音、伴奏分离与混音；通过 JSONL 与桌面端通信。

## 许可与致谢

DobStudio 自有代码采用 [MIT License](LICENSE)。核心工程实践借鉴并吸收了 SubStudio 的字幕渲染处理经验与 OmniDub 的语音克隆工程积累。第三方组件及权重模型遵循各自开源许可证：

- CosyVoice：[Apache-2.0](engine/vendor/CosyVoice/LICENSE)
- Matcha-TTS：[MIT](engine/vendor/CosyVoice/third_party/Matcha-TTS/LICENSE)
- XTTS-v2 权重模型：[Coqui Public Model License](https://huggingface.co/coqui/XTTS-v2)
