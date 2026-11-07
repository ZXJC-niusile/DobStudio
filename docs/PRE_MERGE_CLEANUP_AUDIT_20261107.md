# OmniDub 合并前冗余与结构整理审计

核对日期：2026-11-07。范围仅为 OmniDub；另一个项目尚未纳入比较。
本轮不修改业务代码、不删除文件、不合并或更新 PR，仅新增本报告和复现记录。

## 1. 结论

项目的主要负担是职责、配置和状态管理重复，不是大量完全无用的文件。
建议先收敛开发基线，修复重复状态管理引出的错误，再抽出稳定的配音入口。
不建议现在大规模删减 CosyVoice 源码、移除 XTTS 或重写全部流水线。

### 审计基线

- 主工作区：`D:/User Hub/GitHub/OmniDub`，分支 `main`，HEAD `7b161e58f110ea4712ca4599b02ae892325b0e17`。
- 主工作区另有 7 个已跟踪文件的未提交修改，以及 `speaker_reference.py` 和此前调研/策略文档。
- 独立工作树 `.worktrees/native-tn`：`codex/cosyvoice-native-normalization`，HEAD `f79354d0a5112490ea7d1545aea8abfbdb9b158e`，工作树干净。
- GitHub [PR #13](https://github.com/ZXJC-niusile/OmniDub/pull/13) 本次查询仍为 open / unmerged；它不是当前主工作区代码。
- 所有下述行号按当前主工作区，除非明确写出 PR 分支。不能把两个分支的测试数量相加当作一个已集成版本。

### 规模

按 Git 跟踪文件清单、读取当前工作区内容统计：66 个文件约 1.66 MB；
应用 Python 文件 14 个、5,209 行；内嵌 CosyVoice Python 文件 36 个、8,830 行；
测试 Python 文件 2 个、1,204 行。未跟踪的 `speaker_reference.py` 未计入这些数量。
CosyVoice 目录全部跟踪文件约 1.37 MB，包含 tokenizer 资产。
本地 `.worktrees` 在补装测试依赖前约 262 MB / 1,895 个文件，主要包括独立源码工作树和虚拟环境。
这些工作树文件未被 Git 跟踪，不能把其大小当成项目发布包大小。

## 2. 当前结构及适合保留的边界

```text
app.py（Gradio）
  └─ pipeline.py（在线/本地入口、配置、并发、预热、缓存、重试）
      ├─ step000 / 本地导入 → download.mp4 + download.info.json
      ├─ step010 → audio.wav / audio_vocals.wav / audio_instruments.wav
      ├─ step020 → transcript.json / SPEAKER 音频及提示文本
      ├─ step030 → summary.json / translation.json
      ├─ step040 → 引擎适配器 → 分段音频 / translation_tts.json / audio_combined.wav
      ├─ step050 → subtitles.srt / video.mp4
      └─ step060 → video.txt / 可选 video.png
```

下载、本地导入、ASR、翻译、TTS、时间轴和合成本身是不同职责，不因都接收 `folder` 就属于重复模块。
`translation.json` 和 `translation_tts.json` 分别保存原翻译与合成后的时间轴，也不是应该合并掉的重复数据。

## 3. 合并前优先处理

### R1：两条未收敛的开发线（最高优先级）

当前工作区仍使用扩展后的自研文本预处理；PR #13 将 CosyVoice 路径交给原生前端。
两边同时修改 `pipeline.py`、`step040_tts.py`、`step043_tts_cosyvoice.py` 和测试。
这是后续整合必须先解决的基线问题，不是删掉旧工作树就能解决的冗余。

建议：先保存当前修复为可追溯提交，再将原生前端方案与源文件保护、参考音频校验、
失败恢复修复整合成一条基线。遵守已选定的原生 TN 方案，不重新扩张自研规则。
整理完成应从一个干净 checkout 运行完整测试；本轮没有执行这个合并。

### R2：两份全局 torch.load 补丁会互相干扰（已复现）

位置：`youdub/step042_tts_xtts.py:33` 与 `youdub/step020_whisperx.py:37`。
两个上下文管理器各自持有不同的锁，却修改同一个 `torch.load` 全局函数。
`pipeline.py:375` 的并行模型预热允许 XTTS 与 WhisperX 加载过程重叠。

复现按 A-enter → B-enter → A-exit → B-exit 执行两个真实上下文：
A 退出时提前移除了仍在运行的 B 所需补丁；全部退出后 `torch.load` 仍不是原函数。
这是确定性交错实验，未下载模型；它证明状态恢复错误，不证明真实权重加载必然触发该时序。

建议：合并成一个共享兼容层，统一锁和恢复逻辑，尽量采用库支持的显式加载参数。
不能只复制一份同名辅助函数到两个模块，独立锁仍然无效。
验收要覆盖交错退出和异常退出，并检查全局函数身份恢复。

### R3：XTTS 同时存在两套模型缓存，缓存键遗漏权重路径（已复现）

位置：`youdub/step042_tts_xtts.py:104`、`:149`。
普通加载使用 `_models[device]`，CPU 回退单独使用 `_cpu_model`。
在模拟实际构造器的实验中：

- `load_model('model-A', 'cpu')` 后调用 `load_model('model-B', 'cpu')` 返回同一个 A 实例。
- 随后 `_get_cpu_model('model-A')` 又构造第二个 A 实例。

建议：合并成按规范化权重路径和设备标识缓存的唯一模型注册表；
CPU 回退通过同一注册表取模型。保留推理锁，不能以去冗余为由删掉线程保护。
其他引擎也有注册表，但第一步只统一明确重复且出错的 XTTS 路径，避免过早造通用框架。

### R4：配置重复保存，执行配置与缓存指纹可能不一致（已复现）

位置：`youdub/step030_translation.py:11–29`、`youdub/pipeline.py:299`。
翻译模块在导入时读取 `MODEL_NAME` 和 `TRANSLATION_BATCH_SIZE`；
流水线生成缓存指纹时重新读取环境变量。
导入后切换环境变量，实验得到：指纹记录 `audit-other-model` / `99`，
实际模块仍是 `gpt-3.5-turbo` / `10`。未来作为另一个项目内的长期运行组件时尤其容易发生。

另：`_transcript_spec` 未纳入 `whisper_min_speakers` / `whisper_max_speakers`；
只修改这两个配置，缓存身份完全不变（已验证）。

建议：进程边界加载环境配置，形成每任务明确的配置对象，同时供执行器和指纹使用。
把影响实际输出的配置字段列成表，避免在多个模块分别补字段；不把 API 密钥写入指纹或日志。

### R5：步骤缓存与步骤内部的“文件存在就跳过”重复（已复现复用风险）

位置：`youdub/utils.py:240`、`youdub/step030_translation.py:615`、
`youdub/step050_synthesize_video.py:239`、`youdub/step040_tts.py:311`。
流水线按参数指纹判断，部分独立步骤仅按输出文件存在判断；TTS 又有分段指纹。
实验预置旧 `translation.json`，直接调用 `translate(..., target_language='English')`：
返回成功，不调用翻译函数，旧结果保留。

目前通过完整流水线调用时，外层会清理失效输出；此处不是声称主入口必定复用错结果。
风险是合并后新项目直接复用阶段函数，绕过了外层契约。
建议：明确唯一的步骤缓存负责人；对外暴露带配置检查的入口，内部执行函数只负责执行。
步骤缓存与分段恢复缓存粒度不同，后者应保留；统一元数据与失效规则，而不是简单删除一层。

### R6：即使所有步骤命中缓存，入口仍预热全部模型（已验证调用行为）

位置：`youdub/pipeline.py:375`、`:711`、`:804` 附近的两个入口。
将所有步骤设置为缓存命中并模拟模型构造，本地入口仍调用一次 Demucs、一次 WhisperX、
一次 CosyVoice 预热，再返回成功。由源码可知，新进程会因此尝试加载本不需要的模型；
本轮没有测量实际显存和耗时。

建议：先规划待执行阶段，再仅预热所需模型，或按阶段首次使用加载。
这也使将来仅需要字幕合成、仅翻译的任务无需初始化整个模型栈。

## 4. 可以整理的普通冗余

### R7：在线与本地入口重复维护调度流程

位置：`youdub/pipeline.py:643`、`:748`。
两者重复维护 GPU 预留、预热、单线程/线程池分支、设备分配、Future 异常处理和成功计数。
来源准备逻辑不同，应分别保留；后续的批量执行与结果收集可以共用。
建议抽出小型批处理函数，返回结构化结果，由 UI 转成字符串。
不建议为当前体量引入新的任务队列服务。

### R8：UI 与流水线重复维护校验、语言映射和默认值

位置：`app.py:11`、`youdub/pipeline.py:613`、`youdub/step040_tts.py:28`、
`youdub/step020_whisperx.py:103`、`youdub/speaker_reference.py:19`。
UI 和核心各自实现 XTTS 确认及语言兼容检查；同一核心校验的双层调用可以保留，
但条件和错误文案不应各写一份。语言别名、目标语言列表分散维护，也容易逐渐不一致。
主入口默认 CosyVoice，`generate_wavs` 与其演示 CLI 默认 XTTS，复用方式不同会选不同引擎。

建议：集中引擎能力、语言别名与配置默认值；UI 调用核心校验并负责展示错误。
校验集中不等于取消后端校验或取消 XTTS 确认。

### R9：少量完全重复的帮助函数与无调用代码

- `pipeline.py:258` 与 `step020_whisperx.py:342` 的 speaker WAV 存在检查，去掉函数名和文档后 AST 完全相同，可共用。
- `pipeline.py:133` 与 `step000_video_downloader.py:41` 都维护 ffmpeg remux→转码回退，可抽出转换函数；保留各自的复制、寻找输入和清理策略。
- `cn_tx.py:12–16` 中 `sys`、`argparse`、`csv` 没有 AST 读引用，可删除未使用导入。
- `cn_tx.py:552` 的逆向中文转数字及 `chntext2cardinal` / `chntext2fraction` / `chntext2percentage` 没有发现生产调用入口，是可裁剪候选。
- **只在当前未提交实现中**，`Money` / `Percentage` 仅剩定义；HEAD 和 PR 分支仍有调用，不能将“可删除”结论套用到所有分支。

此处的调用检查覆盖仓库内 Python 与文本搜索，不能证明仓库外无人导入这些公开类。
先确定合并后的支持 API，再删除候选；`cn_tx.py` 整体仍用于 XTTS，不能整文件删除。

### R10：导入副作用与文件路径约定妨碍作为组件复用

位置：`app.py:49` 起顶层构造 Gradio UI；`pipeline.py:30–47` 顶层导入所有阶段；
`step010_demucs_vr.py:7`、`step020_whisperx.py:15` 顶层加载 ML 依赖；
两个阶段调用 `load_dotenv()`；`step043_tts_cosyvoice.py:15` 修改进程级 `sys.path`。
这意味着导入统一流水线也要求无关阶段依赖可导入，并可能影响宿主项目环境。

建议：先增加 `create_app()` 工厂、阶段按需导入、统一工作目录/模型目录参数。
核心 API 返回任务状态、产物路径和错误阶段，避免另一个项目解析 `Success: n Fail: n` 字符串。
`folder` 内部的文件约定保留在一个产物布局模块，不必立刻重写所有阶段为全新数据结构。

## 5. 依赖、内嵌库与开发产物

### R11：CosyVoice 有超出当前入口用途的代码，但不是可直接删除的死代码

当前适配器只加载 `iic/CosyVoice-300M`；内嵌源码还包含 CosyVoice2/3、Qwen2LM、
DiT 及训练 forward 路径。README 的“仅保留运行时必需部分”表述过强。
`CosyVoice/cosyvoice/utils/class_utils.py:35–38` 与模型加载代码直接导入这些类型，
配置还经 HyperPyYAML 构造对象，所以不能以主项目没有直接调用为依据删文件。

建议：先将第三方源码作为明确版本的 vendor 边界，记录上游 commit、模型版本、
本地补丁和许可证。只有在真实模型配置/导入闭包/推理验收都可运行后，才评估裁剪。
许可证、tokenizer 资产和 Matcha 实际依赖应保留；本轮不判断法律条款，也不做模型质量比较。

### R12：安装声明分散，Matcha 残留与部署说明存在问题

- 基础依赖在根 requirements，CosyVoice 在另一个 requirements，Demucs/WhisperX/XTTS/torch 又由 shell 脚本追加。
- 大部分版本未约束，WhisperX 从 Git 未固定 commit；目前没有一个可直接用于合并环境的完整依赖入口。
- 安装检查 `scripts/install_all.sh:63` 的模块列表没有验证 CosyVoice、Matcha 或原生 TN；Matcha 安装失败只警告，后续仍可能显示安装完成。
- `CosyVoice/.gitmodules` 声明 Matcha 子模块，但 Git 索引中的实际文件都是普通 `100644`，没有 gitlink；目前目录只有许可证和空 stub。
- README 和部署指南都要求删掉 `matcha` 后 `git clone ... .`，然而目录还保留 LICENSE，目标不是空目录，命令不能按说明成功执行。

建议：单一安装清单配可选依赖组，固定验收过的版本/提交，部署文档只维护一套完整操作。
明确 Matcha 采用安装包还是本地完整 checkout，并校验真正需要的导入。
不要直接删除 `torchvision` 等“本项目没 import”的依赖：还需要检查上游库依赖。

### R13：开发工作树、测试扫描和文档状态需要隔离

`.gitignore` 未排除 `.worktrees/`。测试 `test_omnidub_regressions.py:184` 从仓库根递归编译，
排除 venv/.venv 但不排除 `.worktrees`，会把另一分支源码也纳入编译范围。
这会让当前分支验证范围受本地开发布局影响。

建议：忽略开发工作树，测试只枚举被测源码根或当前 Git 跟踪文件。
已有工作树通过 Git worktree 生命周期管理，保留未合并提交，不直接递归删除。
把研究报告作为决策档案保留，将 `TEXT_AND_REFERENCE_POLICY.md` 更新为最终整合方案，
避免旧策略文档和原生前端文档并列但未标明适用分支。
测试中缺失 ML 包时自动注入 stub，适合快速行为测试，但不能证明部署环境完整；
应与真实依赖导入检查、真实前端测试、GPU 端到端验收分开标记。

## 6. 不应该因为“去冗余”而删除

1. XTTS：目前承担 CosyVoice 未覆盖的语言能力；是否移除是功能取舍。
2. 声纹配对元数据、hash、缓存 pending/success 区分：它们解决完整性和失败恢复问题。
3. 原文、翻译、TTS 时间轴及分段中间音频：分别服务可追溯性、字幕对齐和断点恢复。
4. `save_wav` 与 `save_wav_norm`：分别执行裁剪写入和幅值归一化，语义不同，不应盲目合并调用行为。
5. 翻译摘要：`_translate` 使用摘要构造上下文，不能因为有 `step060_generate_info` 就认为摘要全是重复功能。
   只有发布用缩略图、video.txt、标签翻译等可以评估为可选步骤。
6. GPU 设备映射、模型加载锁和推理锁：作用不同，重复出现不等于冗余。

## 7. 建议执行顺序与验收

| 批次 | 范围 | 验收目标 |
|---|---|---|
| 1 | 收敛本地修复与 PR #13，保存干净基线 | 同一 checkout 的源码、依赖、策略文档和测试对应同一版本 |
| 2 | R2/R3/R4：共享加载兼容、XTTS 注册表、任务配置及缓存身份 | 补丁交错恢复正确；路径切换取对模型；执行配置与指纹一致 |
| 3 | R5/R6/R7/R8：缓存责任、按需加载、共用调度、统一能力声明 | 全缓存任务不加载模型；阶段复用不误用旧输出；在线/本地结果一致 |
| 4 | R9/R10/R12/R13：小范围去重、组件入口、依赖和开发隔离 | 不安装 GPU 栈也能导入轻量配置/接口；测试不扫描别的工作树 |
| 暂缓 | R11 大规模第三方裁剪、引擎删减、与第二项目的模块映射 | 待另一项目完成、功能范围与真实推理验收就绪后决定 |

合并前最值得留下的是“可独立调用的配音核心 + 引擎适配器 + 明确产物/配置契约”。
Gradio UI、在线下载、发布摘要可以作为外围能力；现有核心逻辑无需全部推翻。

## 8. 实际验证与未验证项

- AST/引用检查覆盖 Git 跟踪的 Python 文件，包含内嵌库；未跟踪的声纹辅助模块另行阅读。
- 阅读主要业务链路、安装脚本、依赖、文档；内嵌库检查入口、导入关系和模型类型，未声称逐行验证第三方数值实现。
- 当前主工作区既有 25 项回归测试全部通过；测试使用现有轻量依赖替身。
- 追加了不落业务代码的针对性实验：R2/R3/R4/R5/R6，结果见 `PRE_MERGE_AUDIT_EVIDENCE_20261107.json`。
- `git diff --check` 通过。测试与实验未调用翻译 API、下载模型或执行 GPU 语音合成。
- 当前 Python 缺少 numpy；仅在已有隔离虚拟环境内补装 numpy 以执行测试，未改全局环境。
- 未重新运行 PR 分支整套测试；未做第二项目交叉比较、依赖解析兼容性全量求解或真实音视频听审。
