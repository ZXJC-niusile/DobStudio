import { useState } from "react";
import type { Project, TaskRequest, Settings } from "@dobstudio/core/studio";
import { api, type Act } from "../bridge";

export function DubbingPanel({
  project,
  busy,
  act,
  submit,
  settings,
}: {
  project: Project;
  busy: boolean;
  act: Act;
  submit: (r: TaskRequest) => Promise<void>;
  settings?: Settings;
}) {
  const [engine, setEngine] = useState<"cosyvoice" | "xtts">(
    settings?.defaultTtsEngine || "cosyvoice",
  );
  const [referencePath, setPath] = useState("");
  const [referenceText, setText] = useState("");
  const [referenceLanguage, setLanguage] = useState("zh");
  const [targetLanguage, setTarget] = useState("zh");
  const [separateBgm, setSeparateBgm] = useState(false);
  const [ducking, setDucking] = useState(true);
  const [bgmVolume, setBgmVolume] = useState(0.3);

  return (
    <div className="split">
      <div className="panel">
        <div className="eyebrow">
          {engine === "cosyvoice"
            ? "COSYVOICE · 原生文本前端"
            : "XTTS · 轻量跨语言克隆"}
        </div>
        <h2>为译文赋予声音</h2>
        <p className="muted">
          使用一段完整的 0.5–29 秒 WAV
          作为声音参考。配音读取已保存的译文与时间区间。
        </p>

        {/* TTS 克隆引擎选择 */}
        <div className="modular-block">
          <label className="modular-label">TTS 克隆引擎选择</label>
          <div className="engine-card-grid">
            <div
              role="button"
              tabIndex={0}
              className={`engine-card ${engine === "cosyvoice" ? "active" : ""}`}
              onClick={() => setEngine("cosyvoice")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setEngine("cosyvoice");
              }}
            >
              <div className="engine-card-header">
                <span className="engine-radio-dot" />
                <b>CosyVoice (高保真克隆)</b>
                <span className="badge badge-accent">推荐</span>
              </div>
              <p className="engine-card-desc">
                阿里通义高保真复刻，原生文本前端规整，音色拟真度极高，适合中文及中英双语精细克隆。
              </p>
            </div>

            <div
              role="button"
              tabIndex={0}
              className={`engine-card ${engine === "xtts" ? "active" : ""}`}
              onClick={() => setEngine("xtts")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setEngine("xtts");
              }}
            >
              <div className="engine-card-header">
                <span className="engine-radio-dot" />
                <b>XTTS (轻量跨语言克隆)</b>
                <span className="badge badge-subtle">多语种极速</span>
              </div>
              <p className="engine-card-desc">
                Coqui 轻量级跨语种多发音人引擎，显存需求低、推理极速，适合 17+
                国语言自由转换。
              </p>
            </div>
          </div>
        </div>

        {/* 背景人声分离与伴奏保留 */}
        <div className="modular-card">
          <div className="toggle-row">
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={separateBgm}
                onChange={(e) => setSeparateBgm(e.target.checked)}
              />
              <span className="toggle-slider" />
              <span className="toggle-label-text">
                分离并保留原片背景音乐 (BGM 混音)
              </span>
            </label>
            <span
              className={`badge ${separateBgm ? "badge-accent" : "badge-muted"}`}
            >
              {separateBgm ? "已开启 Demucs 伴奏分离" : "纯净配音干声"}
            </span>
          </div>

          <div className="hardware-notice">
            💡 <strong>硬件与场景说明</strong>：开启后将使用 Demucs
            提取伴奏并在说话时智能降鸭；适合有配乐的视频，需要较多显存/算力。若为纯演讲或无伴奏视频建议关闭以极速生成。
          </div>

          {separateBgm && (
            <div className="sub-options">
              <div className="toggle-row">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={ducking}
                    onChange={(e) => setDucking(e.target.checked)}
                  />
                  <span>自动降鸭 (Ducking)：有人声时背景音乐自动压低</span>
                </label>
              </div>

              <div className="slider-control">
                <div className="slider-header">
                  <span>伴奏音量 (BGM 音量)</span>
                  <b className="slider-value">{Math.round(bgmVolume * 100)}%</b>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.05"
                  value={bgmVolume}
                  onChange={(e) => setBgmVolume(parseFloat(e.target.value))}
                  className="range-input"
                />
                <div className="slider-ticks">
                  <span>0% (静音)</span>
                  <span>30% (推荐默认)</span>
                  <span>50%</span>
                  <span>100% (原音量)</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 声音参考音频与语言 */}
        <label>
          声音参考
          <div className="inline">
            <input
              readOnly
              value={referencePath}
              placeholder="选择参考 WAV (0.5–29 秒)"
            />
            <button
              onClick={() =>
                void act(async () => {
                  const p = await api.pick("reference");
                  if (p) setPath(p);
                })
              }
            >
              浏览
            </button>
          </div>
        </label>

        <div className="inline">
          <label>
            参考语言
            <input
              value={referenceLanguage}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="如 zh / en"
            />
          </label>
          <label>
            目标语言
            <input
              value={targetLanguage}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="如 zh / en"
            />
          </label>
        </div>

        <label>
          参考音频的逐字原文（可选）
          <textarea
            rows={3}
            value={referenceText}
            onChange={(e) => setText(e.target.value)}
            placeholder="仅在确认与整段参考音频逐字匹配时填写；跨语言配音建议留空使用纯声音特征参考。"
          />
        </label>

        <button
          className="primary"
          disabled={busy || !referencePath || !project.cues.length}
          onClick={() =>
            void submit({
              kind: "dubbing",
              options: {
                referencePath,
                referenceText,
                referenceLanguage,
                targetLanguage,
                engine,
                separateBgm,
                ducking,
                bgmVolume,
              },
            })
          }
        >
          生成配音与视频
        </button>
      </div>

      <div className="panel">
        <h3>本次输出与管线流程</h3>
        <ol>
          <li>
            <b>选用引擎</b>：
            {engine === "cosyvoice"
              ? "CosyVoice (高保真克隆)"
              : "XTTS (轻量跨语言克隆)"}
          </li>
          <li>
            <b>伴奏混音</b>：
            {separateBgm
              ? `Demucs 分离伴奏 + ${ducking ? "智能降鸭" : "固定音量"} (音量 ${Math.round(bgmVolume * 100)}%)`
              : "纯克隆配音轨 (干声，极速生成)"}
          </li>
          <li>
            <b>区间对齐</b>：原字幕区间内自动适配语速并严格对齐时间戳
          </li>
          <li>
            <b>最终交付</b>：输出母带级 WAV 音频与合成高清 MP4 成片
          </li>
        </ol>

        <div className="notice">
          {separateBgm
            ? "已开启 Demucs 背景伴奏保留，生成时将自动提取伴奏音频并在语音段执行降鸭混合。"
            : "当前设置为纯配音干声模式，不保留原片背景音乐。若原视频有背景音乐且需要保留，请在左侧开启伴奏保留。"}
        </div>

        <p className="muted">
          首次使用需在运行设置中配置对应 Python
          环境与模型路径。
        </p>
      </div>
    </div>
  );
}
