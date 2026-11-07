# OmniDub：同类项目与语音前端调研

核对日期：2026-10-30（Asia/Shanghai）。范围：文本规范化、声纹参考、配音时间轴。
证据来自官方源码、项目文档及厂商文档。没有安装或运行外部项目，未做音质排名。
星标和分支快照记录在 [industry_sources_20261030.json](industry_sources_20261030.json)。
本轮新增调研资料，不改变此前尚未提交的业务代码修复。

## 1. 结论与对当前修改的修正

**建议：单一规范化入口 + 可替换的成熟前端 + 引擎各自的参考音频策略 + 真实音频验收。**

上一轮把反复替换改成一次扫描，解决了具体的规则互相干扰，但它仍是自研启发式规则，
不能由 25 项单元测试和组合用例推导出广泛的语言覆盖能力。
在选定长期方案前，宜把它作为待比较的候选/回退实现，而非不断扩张成新的通用 TN 库。

这不否定源文件保护、失败恢复、音频/文本绑定等修复；这些解决的是独立的数据完整性问题。

## 2. 项目选择与当前快照

星标只是选择参考对象的信号，不是正确性或音质证据。下面的推送时间来自仓库元数据，
不等同于最新发布版本日期；所读代码按默认分支提交固定。

| 项目 | 星标 | 最近推送 UTC | 观察重点 |
|---|---:|---|---|
| [CosyVoice](https://github.com/QwenAudio/CosyVoice) | 24,193 | 2026-05-25 | 模型原生文本前端、零样本与跨语种接口 |
| [pyVideoTrans](https://github.com/jianchang512/pyvideotrans) | 19,591 | 2026-10-30 | 独立对齐阶段、音视频变速策略 |
| [VideoLingo](https://github.com/Huanshere/VideoLingo) | 19,005 | 2026-09-30 | 配音专用文本、时长预估与合成后修正 |
| [F5-TTS](https://github.com/SWivid/F5-TTS) | 15,486 | 2026-10-23 | 参考音频裁剪、转写及持续时长估计 |
| [SoniTranslate](https://github.com/R3gm/SoniTranslate) | 1,420 | 2026-08-29 | 按说话人挑选参考片段 |

另查了专业基础组件：WeTextProcessing（832 星）、NeMo-text-processing（516 星）、
wetext runtime（62 星）。纳入它们是因为它们直接处理 TN，或被 CosyVoice 调用，
不是把它们称作高星完整配音产品。各仓库在本次查询时均未归档。

## 3. 文本规范化：规则仍然存在，关键是模块边界和歧义处理

### CosyVoice 的原生前端

SOURCE_FACT：初始化优先加载 `ttsfrd`，失败后尝试 `wetext.Normalizer`；
两者都不可用时进入简化处理路径。推理接口的 `text_frontend` 默认开启。

来源：[frontend.py:55–75、127–160](https://github.com/QwenAudio/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/cli/frontend.py#L55)、
[cosyvoice.py:91–106](https://github.com/QwenAudio/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/cosyvoice/cli/cosyvoice.py#L91)。

PROJECT_FACT：本地 `CosyVoice/cosyvoice/cli/frontend.py` 存在相同前端分支。
`youdub/step040_tts.py` 先运行 `preprocess_text`，而 `step043_tts_cosyvoice.py`
调用推理接口时没有关闭原生前端。当前依赖清单也未明确列出 `wetext` 或 `ttsfrd`。
这里只确认清单内容；尚未验证实际运行环境是否另外安装了它们。

INFERENCE：目前有重复规范化及环境依赖导致输出差异的风险。
例如本地前端在中文分支会把英文句点替换为中文句号，
所以在 OmniDub 层保护 `v1.02`，并不意味着模型输入仍一定是 `v1.02`。
此前型号保护测试只覆盖上游函数，没有覆盖真正的模型前端边界。

RECOMMENDATION：确定唯一负责 TN 的层，明确记录使用了哪个前端、版本及配置。
可比较“原生前端负责 TN”和“统一应用前端负责 TN、引擎关闭重复 TN”两种路径。
不能只关闭原生前端就认定完成，因为它同时承担分句和部分标点处理。

### WeTextProcessing / wetext / NeMo

SOURCE_FACT：WeTextProcessing 将分类标注与读法生成分开，
分别组织日期、分数、度量、金额、时间等规则，并用权重处理竞争路径。
当前接口还提供输入输出片段映射和多个候选，便于检查改写依据。

来源：[中文 normalizer](https://github.com/wenet-e2e/WeTextProcessing/blob/31779ac542df001ad65b7dcdf0de8fcf2daf0c45/tn/chinese/normalizer.py)、
[接口与安装说明](https://github.com/wenet-e2e/WeTextProcessing/blob/31779ac542df001ad65b7dcdf0de8fcf2daf0c45/README.md)。

SOURCE_FACT：`pengzhendong/wetext` 是不依赖 Pynini 的 WeTextProcessing Python runtime，
提供显式语言、TN/ITN、多个候选和映射接口；它与直接开发 WFST 规则的包不是同一个安装入口。
其 README 列出的语言为中、英、日。不能由 WeTextProcessing 的语言列表推断 runtime 也支持全部语言。

来源：[wetext README](https://github.com/pengzhendong/wetext/blob/c188fc775afecb69dc71ce79d0e4b910afacc961/README.md)。

SOURCE_FACT：NeMo 的 hybrid 路径用非确定性 WFST 产生候选，再由预训练掩码语言模型评分。
这为日期、分数等歧义提供了“候选生成—上下文选择”的设计参考，
不等于已经证明该路径对本项目的中文配音更好。

来源：[NeMo hybrid](https://github.com/NVIDIA/NeMo-text-processing/blob/ddadfb2a38d2bc6b8cc6232c4f915eb60f500688/nemo_text_processing/hybrid/README.md)、
[NVIDIA 技术说明](https://developer.nvidia.com/blog/text-normalization-and-inverse-text-normalization-with-nvidia-nemo/)。

RECOMMENDATION：先评估已与 CosyVoice 接近的 wetext 路径，暂不引入完整 NeMo 作为生产依赖。
需要核对锁定版本、Windows 安装、启动成本和实际输出；本轮没有验证这些安装与性能条件。
无论采用哪一种，都保留字幕展示文本和配音读法文本，并允许术语词典/显式读法覆盖。

### 商业语音服务提供的控制方式

SOURCE_FACT：Azure 的 SSML 提供 `say-as`、`phoneme`、`sub`、自定义词典等控制，
可以显式表达“按数量读”还是“按字符读”，而不完全依赖猜测。
ElevenLabs 提供规范化开关、语言代码和发音词典；具体能力依模型而异。

来源：[Azure 发音控制](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-pronunciation)、
[ElevenLabs 规范化说明](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/why-are-numbers-dates-symbols-and-acronyms-not-properly-pronounced-or-spoken-in-the-correct-language)、
[ElevenLabs 发音词典](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/pronunciation-dictionaries)。

RECOMMENDATION：借鉴显式类型和词典机制；不能把 Azure 的 SSML 标签直接传给不支持该协议的本地引擎。
LLM 可协助选择歧义读法，但应限制可改写片段并检查数字、单位、否定词和专名，避免自由改写事实。

## 4. 声纹参考：时长限制应属于引擎，而非全局常量

SOURCE_FACT：F5-TTS 官方推理说明建议参考音频短于 12 秒，并在结尾保留适当静音；
总生成长度包含参考与输出。源码先尝试在静音处截取，最后才硬截。
若没有提供参考文本，它对处理后的音频转写，并按原始音频内容哈希缓存结果。

来源：[F5-TTS 推理说明](https://github.com/SWivid/F5-TTS/blob/45868abaabd74aabf03cd673d6dd00cc9d9c01ae/src/f5_tts/infer/README.md)、
[preprocess_ref_audio_text](https://github.com/SWivid/F5-TTS/blob/45868abaabd74aabf03cd673d6dd00cc9d9c01ae/src/f5_tts/infer/utils_infer.py#L291)。

限制：用户提供非空 `ref_text` 时，所读代码直接采用该文本；
它没有自动证明原始音频被截短后，该文本仍然匹配。
所以可借鉴“先准备最终片段、再取得匹配转写”，但不能据高星认定所有分支都安全。

SOURCE_FACT：SoniTranslate 的 XTTS 自动参考流程按说话人筛选候选，
优先尝试时长在 7–12 秒之间的片段，再有备用选择。
这是该项目对 XTTS 的策略，不是所有 TTS 模型共同的最佳长度。

来源：[create_new_files_for_vc](https://github.com/R3gm/SoniTranslate/blob/70b6390a413bd092c2a6249438f4d75bc5be7093/soni_translate/text_to_speech.py#L525)。

PROJECT_FACT：OmniDub 当前 29 秒限制是为 CosyVoice 的 30 秒上限留余量。
哈希绑定和排除推测时间戳可减少错配，但不能验证音频干净、说话人单一或 ASR 正确。

RECOMMENDATION：每个引擎提供自己的参考规范（长度、采样率、语言、是否需要文本）。
优先选择连续、单说话人的自然片段；把 VAD 边界、重叠说话和噪声作为质量筛选候选指标。
在最终裁剪完成后获取/核对转写，必要时用词级对齐或人工校正。
后两者是本项目建议，本轮没有验证所有被调研项目都如此实现。

## 5. 时长对齐：合成前预估，合成后按实际音频调整

SOURCE_FACT：VideoLingo 有独立的配音用字幕与任务。
它估算阅读时长，对过长文本调用 LLM 缩短，再按真实合成时长决定变速与新字幕时间。

来源：[音频任务](https://github.com/Huanshere/VideoLingo/blob/01f843492759be9bbfd1a5cb697b799cc9de1609/core/_8_1_audio_task.py#L18)、
[分块时长分析](https://github.com/Huanshere/VideoLingo/blob/01f843492759be9bbfd1a5cb697b799cc9de1609/core/_8_2_dub_chunks.py#L64)、
[合成后时间轴](https://github.com/Huanshere/VideoLingo/blob/01f843492759be9bbfd1a5cb697b799cc9de1609/core/_10_gen_audio.py#L173)。

限制：所读版本在达到变速上限后仍超出时间窗时，会从尾部截断，并保存截断日志。
不能为追求对齐直接照搬这一行为到要求保留全部内容的任务。

SOURCE_FACT：pyVideoTrans 把对齐单独作为阶段，按配置处理音频加速、视频变速或字幕跟随音频，
并将调整后的时间写回字幕。

来源：[_stage_align.py](https://github.com/jianchang512/pyvideotrans/blob/aacee3ad9535f87cf2b100e632626972261482b0/videotrans/task/_stage_align.py)、
[_rate.py](https://github.com/jianchang512/pyvideotrans/blob/aacee3ad9535f87cf2b100e632626972261482b0/videotrans/task/_rate.py#L438)。

RECOMMENDATION：建立显式时间预算和超限策略：小幅变速、利用允许的间隙、重新生成/受约束压缩、
最后交由用户选择。记录实际超限、删词、截断、最大语速和字幕漂移，不把任意截断默认为成功。

## 6. 建议实施顺序与验收

1. **先固定模型输入边界。** 日志保存字幕原文、配音文本、最终前端文本、前端版本及模式；
   确保一条路径只由一个组件负责 TN，并明确分句仍由谁执行。
2. **做同输入比较。** 将当前自研实现、CosyVoice 原生前端及显式语言 wetext 放在同一组真实视频句子上比较。
   样例覆盖日期/编号歧义、技术型号、范围/比分、百分数、混合语言、括号内有意义内容等。
   期望读法需人工确认，不由候选实现自己的输出生成标准答案。
3. **按引擎整理参考音频。** 在现有哈希绑定基础上加入最终片段的边界、时长、源语言和质量状态；
   比较连续短片段与当前拼接参考，避免把“更长”或“未截断”当作更好。
4. **做真实小规模端到端验收。** 检查数字/专名是否读错或遗漏、参考转写是否对应、内容是否被缩短/截断、
   配音和字幕的时间误差、冷启动和运行成本。自动回转写只能作辅助，最终需要听审。

接受门槛先以不新增事实改写、数字/专名保真、无静默截断为硬条件；
自然度、音色和时间漂移应在同一批音频上比较，尚无测量结果时不宣称新方案更好。

## 7. 尚未验证

- 没有在本机安装并运行 wetext、NeMo 或外部完整配音项目。
- 没有做真实 GPU 合成、声纹相似度或听感对比。
- 没有验证厂商付费 API 的实际行为。
- 已尝试 ChatGPT 网页辅助研究。Chrome 后来连接成功，但页面未提供技能指定的
  GPT-5.6 Sol / High 选项，因此没有提交研究提示词，也没有取得网页模型研究草稿。
  本文结论来自 Codex 对上述原始来源的核对。
