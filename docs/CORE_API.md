# 配音核心接口

`youdub.pipeline.run_tasks` 是共用执行入口。导入核心接口不加载 ML、Gradio 或 dotenv。
配置在创建任务时从环境读取并冻结；宿主可显式提供配置，不应通过运行中修改环境变量控制任务。

```python
from dataclasses import asdict
from youdub.config import PipelineConfig, TranslationConfig
from youdub.pipeline import run_tasks

cfg = PipelineConfig(
    root_folder="videos",
    translation_target_language="English",
    translation=TranslationConfig(model="your-model", api_key="your-key"),
    generate_metadata=False,
    max_workers=1,
)
result = run_tasks(["/absolute/path/input.mp4"], cfg, source="local")
for task in result.tasks:
    print(asdict(task))
```

source 支持 local、online、folder。folder 接收包含 download.mp4 的现有产物目录，
由宿主负责下载或导入。结果按输入顺序包含 source、folder、success、artifacts、
error_stage、error。online 的元数据获取失败和非法配置可能直接抛异常；已提交任务的失败记录在结果中。
`generate_metadata=False` 不生成发布说明与封面，翻译仍使用摘要上下文。
XTTS 需明确配置本地权重并传入 `xtts_cpml_ack=True`。

原 process_online_video/process_local_video 仅作 UI/兼容适配，返回可读字符串。
UI 通过 `app.create_app()` 构造，只有命令行启动 app.py 时加载 .env。

## 缓存与生命周期

整步缓存由 pipeline 唯一管理。直接调用 translate/transcribe_audio/synthesize_video 等内部阶段
会执行阶段，不再因已有输出而静默跳过。需要恢复功能应调用 run_tasks。
TTS 分段缓存保留，用于失败恢复；它与步骤缓存使用相同任务参数。
模型按阶段首次使用加载，全缓存任务不会预热全部模型。
同一产物目录应由一个任务拥有，宿主不要并发提交写入同一目录的任务。

共享 legacy_torch_load 兼容层协调 XTTS/WhisperX 的补丁；它仍是进程级兼容措施，
宿主自己的 checkpoint 加载不应与该兼容路径并发运行。
XTTS 注册表按绝对权重路径及设备缓存；原地替换同路径权重后需重启并清理相关音频缓存。

## 验证

运行 `python -m unittest discover -s tests -v`。
快速测试会为缺少的 ML 依赖提供替身；真实 wetext 测试需安装 wetext 和 regex。
真实部署检查另运行 `python scripts/check_runtime.py`，启用 XTTS 时添加 `--xtts`。
单元测试和依赖导入均不能替代实际模型合成及听审。
