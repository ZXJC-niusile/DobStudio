import { outputArtifacts } from "./artifacts";
import { useCallback, useEffect, useState } from "react";
import type { Snapshot, TaskRequest } from "@dobstudio/core/studio";
import { SubtitlePanel } from "./views/SubtitlePanel";
import { DubbingPanel } from "./views/DubbingPanel";
import { SettingsPanel } from "./views/SettingsPanel";
import { api, Empty } from "./bridge";
const routes = [
  ["projects", "项目库"],
  ["subtitles", "字幕工作台"],
  ["dubbing", "声音与配音"],
  ["tasks", "任务记录"],
  ["settings", "运行设置"],
] as const;
type Route = (typeof routes)[number][0];
export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [route, setRoute] = useState<Route>("projects");
  const [selected, setSelected] = useState("");
  const [dirty, setDirty] = useState(false);
  function leave(action: () => void) {
    if (!dirty || window.confirm("字幕尚未保存，确定放弃修改？")) {
      setDirty(false);
      action();
    }
  }
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [source, setSource] = useState("");
  const refresh = useCallback(
    async () => setSnapshot(await api.snapshot()),
    [],
  );
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    return api.onChange(() => void refresh().catch((e) => setError(String(e))));
  }, [refresh]);
  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setError("");
    setMessage("");
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const project = snapshot?.projects.find((p) => p.id === selected);
  const busy =
    snapshot?.jobs.some(
      (j) =>
        j.projectId === selected &&
        (j.status === "queued" || j.status === "running"),
    ) ?? false;
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  async function create(value: string) {
    const p = await act(() => api.createProject(value));
    if (p) {
      setSelected(p.id);
      setRoute("subtitles");
      await refresh();
    }
  }
  async function submit(request: TaskRequest) {
    if (!project) return;
    const id = await act(() => api.submit(project.id, request));
    if (id) {
      setMessage("任务已提交，可在任务记录中查看进度");
      await refresh();
    }
  }
  if (!snapshot)
    return (
      <div className="loading">
        <b>DobStudio</b>
        <p>{error || "正在打开工作空间…"}</p>
      </div>
    );
  return (
    <div className="shell" data-testid="studio-ready">
      <aside>
        <div className="brand">
          <span className="brandmark">D</span>
          <div>
            DobStudio<small>字幕 · 声音 · 影像</small>
          </div>
        </div>
        <div className="nav-title">工作空间</div>
        <nav>
          {routes.map(([id, label], i) => (
            <button
              key={id}
              data-route={id}
              className={route === id ? "active" : ""}
              onClick={() => leave(() => setRoute(id))}
            >
              <span>0{i + 1}</span>
              {label}
              {id === "tasks" && (
                <em>
                  {
                    snapshot.jobs.filter(
                      (j) => j.status === "running" || j.status === "queued",
                    ).length
                  }
                </em>
              )}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <span className="dot" />
          独立本地工作空间<small>DobStudio · Beta 2.0</small>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <div className="eyebrow">DOBSTUDIO / {route.toUpperCase()}</div>
            <h1>{routes.find((r) => r[0] === route)?.[1]}</h1>
          </div>
          <div className="project-select">
            <small>当前项目</small>
            <select
              value={selected}
              onChange={(e) => leave(() => setSelected(e.target.value))}
            >
              <option value="">选择项目</option>
              {snapshot.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </header>
        {error && (
          <div className="notice error" role="alert">
            {error}
            <button onClick={() => setError("")}>关闭</button>
          </div>
        )}
        {message && <div className="notice">{message}</div>}
        {route === "projects" && (
          <>
            <div className="hero">
              <div className="eyebrow">从一个片段开始</div>
              <h2>让内容跨越语言。</h2>
              <p>
                导入视频，整理字幕，再用参考声音完成配音。每一步都保留可检查的输出。
              </p>
              <div className="inline">
                <button
                  className="primary"
                  onClick={() =>
                    void act(async () => {
                      const p = await api.pick("media");
                      if (p) await create(p);
                    })
                  }
                >
                  ＋ 导入本地视频
                </button>
                <input
                  placeholder="或粘贴公开视频链接"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
                <button onClick={() => void create(source)}>新建项目</button>
              </div>
            </div>
            <div className="section-heading">
              <h2>最近项目</h2>
              <span>{snapshot.projects.length} 个项目</span>
            </div>
            <div className="project-grid">
              {snapshot.projects.map((p, i) => (
                <button
                  className="project-card"
                  key={p.id}
                  onClick={() => {
                    setSelected(p.id);
                    setRoute("subtitles");
                  }}
                >
                  <div className="project-art">
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    <b>▶</b>
                  </div>
                  <h3>{p.name}</h3>
                  <small>
                    {p.cues.length} 条字幕 · 修订 {p.revision}
                  </small>
                </button>
              ))}
            </div>
            {!snapshot.projects.length && (
              <div className="empty">
                工作空间还是空的。导入第一个视频后，从字幕开始。
              </div>
            )}
          </>
        )}
        {route === "subtitles" &&
          (project ? (
            <SubtitlePanel
              key={project.id}
              project={project}
              busy={busy}
              act={act}
              submit={submit}
              onDirty={setDirty}
            />
          ) : (
            <Empty />
          ))}
        {route === "dubbing" &&
          (project ? (
            <DubbingPanel
              key={project.id}
              project={project}
              busy={busy}
              act={act}
              submit={submit}
              settings={snapshot.settings}
            />
          ) : (
            <Empty />
          ))}
        {route === "tasks" && (
          <div className="panel">
            <h2>任务与输出</h2>
            <p className="muted">
              任务按提交顺序运行。取消会等待计算进程退出后再释放资源。
            </p>
            {snapshot.jobs.map((j) => (
              <div className="job" key={j.id}>
                <span className={"badge " + j.status}>{j.status}</span>
                <div>
                  <b>
                    {snapshot.projects.find((p) => p.id === j.projectId)?.name}{" "}
                    /{" "}
                    {j.kind === "dubbing"
                      ? "配音"
                      : j.kind === "export-video"
                        ? "字幕成片"
                        : "字幕"}
                  </b>
                  <small>{j.stage}</small>
                  {j.error && <p className="error-text">{j.error}</p>}
                  <div className="inline">
                    {outputArtifacts(j.result).map((artifact) => (
                      <button
                        key={artifact.key}
                        onClick={() =>
                          void act(() => api.reveal(artifact.path))
                        }
                      >
                        {artifact.label} ↗
                      </button>
                    ))}
                  </div>
                </div>
                {["queued", "running"].includes(j.status) && (
                  <button onClick={() => void act(() => api.cancel(j.id))}>
                    取消
                  </button>
                )}
              </div>
            ))}
            {!snapshot.jobs.length && <div className="empty">还没有任务</div>}
          </div>
        )}
        {route === "settings" && (
          <SettingsPanel settings={snapshot.settings} act={act} />
        )}
      </main>
    </div>
  );
}
