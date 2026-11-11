import { useEffect, useState } from "react";
import type { Settings } from "@dobstudio/core/studio";
import { PROVIDER_PRESETS } from "@dobstudio/core/catalog";
import { api, type Act } from "../bridge";

export function SettingsPanel({
  settings,
  act,
}: {
  settings: Settings;
  act: Act;
}) {
  const [draft, setDraft] = useState(settings);
  const [status, setStatus] = useState<{ name: string; present: boolean }[]>(
    [],
  );
  const [installing, setInstalling] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.status().then(setStatus);
  }, []);

  const provider = draft.provider || {
    id: "default",
    name: "翻译服务",
    baseUrl: "",
    apiKey: "",
    model: "",
  };

  return (
    <div className="split">
      <div className="panel">
        <h2>推理与语音引擎设置</h2>

        <label>
          默认克隆引擎
          <select
            value={draft.defaultTtsEngine || "cosyvoice"}
            onChange={(e) => {
              setSaved(false);
              setDraft({
                ...draft,
                defaultTtsEngine: e.target.value as "cosyvoice" | "xtts",
              });
            }}
          >
            <option value="cosyvoice">CosyVoice (高保真克隆)</option>
            <option value="xtts">XTTS (轻量跨语言克隆)</option>
          </select>
        </label>

        <label>
          Python 解释器
          <div className="inline">
            <input
              value={draft.python}
              onChange={(e) => {
                setSaved(false);
                setDraft({ ...draft, python: e.target.value });
              }}
            />
            <button
              onClick={() =>
                void act(async () => {
                  const p = await api.pick("python");
                  if (p) {
                    setSaved(false);
                    setDraft({ ...draft, python: p });
                  }
                })
              }
            >
              选择
            </button>
          </div>
        </label>

        <label>
          CosyVoice 模型目录
          <div className="inline">
            <input
              value={draft.modelPath}
              placeholder="本地 CosyVoice 模型目录"
              onChange={(e) => {
                setSaved(false);
                setDraft({ ...draft, modelPath: e.target.value });
              }}
            />
            <button
              onClick={() =>
                void act(async () => {
                  const p = await api.pick("model");
                  if (p) {
                    setSaved(false);
                    setDraft({ ...draft, modelPath: p });
                  }
                })
              }
            >
              选择
            </button>
          </div>
        </label>

        <label>
          XTTS 模型路径
          <div className="inline">
            <input
              value={draft.xttsModelPath || ""}
              placeholder="本地 XTTS 模型路径或检查点目录 (可选)"
              onChange={(e) => {
                setSaved(false);
                setDraft({ ...draft, xttsModelPath: e.target.value });
              }}
            />
            <button
              onClick={() =>
                void act(async () => {
                  const p = await api.pick("model");
                  if (p) {
                    setSaved(false);
                    setDraft({ ...draft, xttsModelPath: p });
                  }
                })
              }
            >
              选择
            </button>
          </div>
        </label>

        <label>
          推理设备
          <select
            value={draft.device}
            onChange={(e) => {
              setSaved(false);
              setDraft({
                ...draft,
                device: e.target.value as "cpu" | "cuda",
              });
            }}
          >
            <option value="cpu">CPU (免独显 / 兼容性好)</option>
            <option value="cuda">CUDA (NVIDIA GPU 硬件加速)</option>
          </select>
        </label>

        <h3>兼容 OpenAI 的翻译服务</h3>
        <label>
          选择预设服务商 (一键填入)
          <select
            value={
              PROVIDER_PRESETS.find((p) => p.baseUrl === provider.baseUrl)
                ?.id || ""
            }
            onChange={(e) => {
              const preset = PROVIDER_PRESETS.find(
                (p) => p.id === e.target.value,
              );
              if (preset) {
                setSaved(false);
                setDraft({
                  ...draft,
                  provider: {
                    id: preset.id,
                    name: preset.name,
                    baseUrl: preset.baseUrl,
                    model: preset.defaultModel,
                    apiKey: provider.apiKey || "",
                  },
                });
              }
            }}
          >
            <option value="">自定义配置 (Custom Provider)</option>
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.defaultModel ? `· ${p.defaultModel}` : ""}
              </option>
            ))}
          </select>
        </label>

        {(() => {
          const matched = PROVIDER_PRESETS.find(
            (p) => p.baseUrl === provider.baseUrl,
          );
          if (!matched) return null;
          return (
            <div
              className="notice"
              style={{
                marginTop: "4px",
                marginBottom: "8px",
                fontSize: "12px",
              }}
            >
              <span>
                <b>{matched.name} 预设</b>
              </span>
              {matched.keyUrl && (
                <span style={{ marginLeft: "8px" }}>
                  获取 Key: <code>{matched.keyUrl}</code>
                </span>
              )}
              {matched.notes && (
                <div style={{ marginTop: "2px", opacity: 0.85 }}>
                  {matched.notes}
                </div>
              )}
            </div>
          );
        })()}

        {(["baseUrl", "model", "apiKey"] as const).map((key) => (
          <label key={key}>
            {key}
            <input
              type={key === "apiKey" ? "password" : "text"}
              value={provider[key]}
              onChange={(e) => {
                setSaved(false);
                setDraft({
                  ...draft,
                  provider: { ...provider, [key]: e.target.value },
                });
              }}
            />
          </label>
        ))}

        <div className="inline">
          <button
            className="primary"
            onClick={() =>
              void act(async () => {
                await api.saveSettings(draft);
                setSaved(true);
              })
            }
          >
            保存设置
          </button>
          {saved && <small className="success">已保存</small>}
          <button
            onClick={() => {
              setSaved(false);
              setDraft({ ...draft, provider: undefined });
            }}
          >
            清除翻译配置
          </button>
        </div>

        <p className="muted">
          设置保存在当前用户的 DobStudio 工作目录。
        </p>
      </div>

      <div className="panel">
        <h2>字幕运行环境</h2>
        <p className="muted">
          字幕功能使用 FFmpeg、whisper.cpp 与 yt-dlp，无需加载 PyTorch。
        </p>
        {status.map((s) => (
          <div className="runtime-row" key={s.name}>
            <b>{s.name}</b>
            <span className={s.present ? "success" : "muted"}>
              {s.present ? "已就绪" : "未安装"}
            </span>
          </div>
        ))}
        <button
          disabled={installing}
          onClick={() =>
            void act(async () => {
              setInstalling(true);
              try {
                await api.install("base");
                setStatus(await api.status());
              } finally {
                setInstalling(false);
              }
            })
          }
        >
          {installing ? "正在安装，请稍候…" : "安装字幕工具与 base 模型"}
        </button>
      </div>
    </div>
  );
}
