# 部署指南

推荐 Linux、Conda、ffmpeg；GPU 模式需可用的 NVIDIA 驱动。

```bash
bash scripts/install_all.sh
# 可选 XTTS：
INSTALL_XTTS=1 bash scripts/install_all.sh
```

脚本创建 Python 3.10 环境，单独安装目标 CUDA 的 PyTorch，然后通过统一依赖入口安装运行库。
默认入口是 requirements.txt；XTTS 入口 requirements-xtts.txt 包含默认运行库及 TTS。
CosyVoice 的依赖仍由其 requirements 文件声明，由根入口引用，不在脚本里重复维护包列表。
WhisperX 固定源码提交，wetext 固定 0.2.0；其余依赖尚未形成完整锁文件，不宣称跨平台解析结果完全一致。

安装后执行 pip check 和 scripts/check_runtime.py；Matcha 或原生前端不可导入时安装失败，
不会仅打印警告后宣称成功。运行时检查不下载语音权重、不发起翻译请求。

```bash
conda activate omnidub
cp .env.example .env
# 填入 OPENAI_API_KEY、MODEL_NAME、HF_TOKEN 等配置
python app.py
```

完整环境变量说明见 README.md。宿主项目调用核心时自行加载配置，见 CORE_API.md。
XTTS 仍需自行准备本地权重、设置 OMNIDUB_XTTS_LOCAL_PATH 并明确确认使用条款。

## Matcha 安装失败

默认使用安装包 matcha-tts。若目标平台无法安装，应依据上游说明在空的新目录构建安装包，
或在可支持的平台部署；不要在包含 LICENSE 的原占位目录执行 git clone ... .。
仓库保留许可证，已移除空 Python stub 和非真实子模块声明。完整本地 checkout 的旧路径检测仍兼容。

## 验证边界

```bash
python -m unittest discover -s tests -v
python scripts/check_runtime.py
# 仅启用 XTTS 时：
python scripts/check_runtime.py --xtts
```

2026-11-08 的代码整理在隔离 Python 3.13 环境完成快速测试及真实 wetext 文本测试。
没有在干净的 Linux/Python 3.10 GPU 环境重新安装全部依赖，也未完成真实模型下载、合成与听审。
完整依赖烟雾检查应在实际部署环境执行；替身单测通过不等于部署检查通过。

首次使用会按需下载模型。任务配置变动通过缓存指纹触发重算；发布结果与中间产物默认在 videos/。
并行 worker 数量按实际显存设置，不要并发写入同一任务目录。
