import { MediaPreview } from "./MediaPreview";
import { useEffect, useRef, useState } from "react";
import type { Project, TaskRequest } from "@dobstudio/core/studio";
import type { BilingualCue, WhisperModel } from "@dobstudio/core";
import { api, type Act } from "../bridge";
import { useVirtualRows } from "../useVirtualList";

export function SubtitlePanel({
  project,
  busy,
  act,
  submit,
  onDirty,
}: {
  project: Project;
  busy: boolean;
  act: Act;
  onDirty: (dirty: boolean) => void;
  submit: (r: TaskRequest) => Promise<void>;
}) {
  const [cues, setCues] = useState(project.cues);
  const [revision, setRevision] = useState(project.revision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const locked = busy || saving;
  const [model, setModel] = useState<WhisperModel>("base");
  const [target, setTarget] = useState("");
  const [audioSource, setAudioSource] = useState<
    "original" | "dubbing" | "dubbing-with-bgm"
  >("original");
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [aspectRatio, setAspectRatio] = useState<"original" | "16:9" | "9:16">(
    "original",
  );
  const [seek, setSeek] = useState<{ ms: number; sequence: number } | null>(
    null,
  );
  const ref = useRef<HTMLDivElement>(null);
  const virtual = useVirtualRows(ref, cues, 132);

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    if (!dirty && project.revision >= revision) {
      setCues(project.cues);
      setRevision(project.revision);
    }
  }, [project.revision, dirty, revision]);

  function edit(i: number, patch: Partial<BilingualCue>) {
    if (busy || savingRef.current) return;
    setCues((rows) => rows.map((c, n) => (n === i ? { ...c, ...patch } : c)));
    setDirty(true);
  }

  return (
    <div className="editor-workspace">
      <div className="editor-steps">
        <span className="current">
          <b>01</b> 识别与翻译
        </span>
        <i />
        <span>
          <b>02</b> 校对字幕
        </span>
        <i />
        <span>
          <b>03</b> 导出成片
        </span>
        <small>SUBTITLE STUDIO</small>
      </div>

      <div className="panel transcription-panel">
        <div className="inline">
          <label>
            识别模型
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as WhisperModel)}
            >
              {[
                "tiny",
                "base",
                "small",
                "medium",
                "large-v3",
                "large-v3-turbo",
              ].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            翻译语言
            <input
              value={target}
              placeholder="留空仅转写；如 zh / en"
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={locked || dirty}
            onClick={() =>
              void submit({
                kind: "subtitles",
                options: { model, targetLang: target.trim() || undefined },
              })
            }
          >
            生成字幕
          </button>
          <button
            disabled={locked || dirty}
            onClick={() => void act(() => api.importSrt(project.id, revision))}
          >
            导入 SRT
          </button>
          <button
            disabled={locked || dirty}
            onClick={() => void act(() => api.exportSrt(project.id))}
          >
            导出 SRT
          </button>
        </div>
      </div>

      <MediaPreview
        projectId={project.id}
        source={project.source}
        cues={cues}
        seek={seek}
      />

      {/* 成片导出工具条 */}
      <div className="export-toolbar-card">
        <div className="export-toolbar-top">
          <div className="export-toolbar-title">
            <b>成片导出配置</b>
            <small>选择成片音轨、字幕烧录开关与画幅比例</small>
          </div>
          <div className="export-toolbar-badges">
            <span
              className={`badge ${burnSubtitles ? "badge-accent" : "badge-muted"}`}
            >
              {burnSubtitles ? "硬字幕烧录" : "仅合成音轨"}
            </span>
            <span className="badge">
              {aspectRatio === "original"
                ? "原比例"
                : aspectRatio === "16:9"
                  ? "16:9 横屏"
                  : "9:16 短视频竖屏"}
            </span>
          </div>
        </div>

        <div className="export-toolbar">
          <label>
            成片音轨
            <select
              value={audioSource}
              onChange={(e) =>
                setAudioSource(
                  e.target.value as "original" | "dubbing" | "dubbing-with-bgm",
                )
              }
            >
              <option value="original">原视频音轨</option>
              <option value="dubbing">纯克隆配音轨 (干声)</option>
              <option value="dubbing-with-bgm">配音 + 原片伴奏混音轨</option>
            </select>
          </label>

          <label>
            导出画幅
            <select
              value={aspectRatio}
              onChange={(e) =>
                setAspectRatio(e.target.value as "original" | "16:9" | "9:16")
              }
            >
              <option value="original">原比例 (保持原画幅)</option>
              <option value="16:9">16:9 横屏 (标准宽屏)</option>
              <option value="9:16">9:16 短视频竖屏 (移动端/抖音)</option>
            </select>
          </label>

          <div className="export-toggle-wrap">
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={burnSubtitles}
                onChange={(e) => setBurnSubtitles(e.target.checked)}
              />
              <span className="toggle-slider" />
              <span className="toggle-label-text">
                {burnSubtitles ? "烧录字幕到画面" : "未勾选 (仅合并音轨不烧录)"}
              </span>
            </label>
          </div>

          <button
            className="primary export-action-btn"
            disabled={locked || dirty || !cues.length}
            onClick={() =>
              void submit({
                kind: "export-video",
                options: { audioSource, burnSubtitles, aspectRatio },
              })
            }
          >
            {burnSubtitles ? "烧录字幕并导出视频" : "合并音轨并导出视频"}
          </button>
        </div>
      </div>

      <div className="section-heading">
        <h2>
          字幕时间轴 <span>{cues.length} 条</span>
        </h2>
        <div className="inline">
          <small>{dirty ? "有未保存修改" : `已保存 · 修订 ${revision}`}</small>
          <button
            className="primary"
            disabled={locked || !dirty}
            onClick={() =>
              void act(async () => {
                if (savingRef.current || busy) return;
                savingRef.current = true;
                setSaving(true);
                try {
                  const p = await api.saveCues(project.id, revision, cues);
                  setCues(p.cues);
                  setRevision(p.revision);
                  setDirty(false);
                } finally {
                  savingRef.current = false;
                  setSaving(false);
                }
              })
            }
          >
            {saving ? "正在保存…" : "保存字幕"}
          </button>
        </div>
      </div>

      {busy && <div className="notice">项目正在排队或运行，字幕暂时只读。</div>}

      <div className="cue-list" ref={ref}>
        <div style={{ height: virtual.totalHeight, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              top: virtual.padTop,
              left: 0,
              right: 0,
            }}
          >
            {virtual.items.map((c, offset) => {
              const i = virtual.startIndex + offset;
              return (
                <div className="cue" key={c.index}>
                  <div className="cue-time">
                    <button
                      className="cue-seek"
                      title="定位视频"
                      onClick={() =>
                        setSeek((previous) => ({
                          ms: c.startMs,
                          sequence: (previous?.sequence ?? 0) + 1,
                        }))
                      }
                    >
                      {String(c.index).padStart(3, "0")} ▶
                    </button>
                    <input
                      aria-label="开始毫秒"
                      type="number"
                      disabled={locked}
                      value={c.startMs}
                      onChange={(e) =>
                        edit(i, { startMs: Number(e.target.value) })
                      }
                    />
                    <input
                      aria-label="结束毫秒"
                      type="number"
                      disabled={locked}
                      value={c.endMs}
                      onChange={(e) =>
                        edit(i, { endMs: Number(e.target.value) })
                      }
                    />
                  </div>
                  <label>
                    原文
                    <textarea
                      disabled={locked}
                      value={c.text}
                      onChange={(e) => edit(i, { text: e.target.value })}
                    />
                  </label>
                  <label>
                    译文 / 配音文本
                    <textarea
                      disabled={locked}
                      value={c.translation || ""}
                      onChange={(e) => edit(i, { translation: e.target.value })}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </div>
        {!cues.length && (
          <div className="empty">
            生成字幕或导入 SRT 后开始编辑。时间单位为毫秒。
          </div>
        )}
      </div>
    </div>
  );
}
