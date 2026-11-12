import { outputArtifacts } from "./artifacts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot, TaskRequest } from "@dobstudio/core/studio";
import { SubtitlePanel } from "./views/SubtitlePanel";
import { DubbingPanel } from "./views/DubbingPanel";
import { SettingsPanel } from "./views/SettingsPanel";
import { api, Empty } from "./bridge";
import { Icon, type IconName } from "./visuals";
import { ProjectsView } from "./views/ProjectsView";
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
  const [importing, setImporting] = useState(false);
  const linkDialog = useRef<HTMLDialogElement>(null);
  const importMedia = () => {
    if (dirty && !window.confirm("字幕尚未保存，确定放弃修改并新建项目？"))
      return;
    void act(async () => {
      const path = await api.pick("media");
      if (path) await create(path);
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        leave(() => {
          setRoute("projects");
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLInputElement>("[data-project-search]")
              ?.focus(),
          );
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty]);
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
      setDirty(false);
      setSelected(p.id);
      setRoute("subtitles");
      await refresh();
      linkDialog.current?.close();
      setSource("");
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
  const icons: IconName[] = ["grid", "captions", "wave", "layers", "settings"];
  const descriptions = {
    projects: "创作空间",
    subtitles: "字幕工作台",
    dubbing: "声音与配音",
    tasks: "任务记录",
    settings: "运行设置",
  };
  const activeCount = snapshot.jobs.filter(
    (j) => j.status === "running" || j.status === "queued",
  ).length;
  return (
    <div className="shell" data-testid="studio-ready">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandmark">
            <Icon name="wave" size={25} />
          </span>
          <div>
            DobStudio<small>THE CREATOR’S STUDIO</small>
          </div>
        </div>
        <button className="sidebar-create" onClick={importMedia}>
          <Icon name="plus" />
          新建项目<span>＋</span>
        </button>
        <div className="nav-title">
          工作空间 <span>WORKSPACE</span>
        </div>
        <nav aria-label="主导航">
          {routes.map(([id, label], i) => (
            <button
              key={id}
              data-route={id}
              aria-label={label}
              aria-current={route === id ? "page" : undefined}
              className={route === id ? "active" : ""}
              onClick={() => leave(() => setRoute(id))}
            >
              <Icon name={icons[i]!} />
              <span>{label}</span>
              {id === "tasks" && activeCount > 0 && <em>{activeCount}</em>}
              {route === id && <i className="nav-indicator" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="mini-spectrum">
            {Array.from({ length: 17 }, (_, i) => (
              <i key={i} style={{ height: 8 + Math.sin(i * 0.8) ** 2 * 20 }} />
            ))}
          </div>
          <b>Make it sound like you.</b>
          <p>让灵感拥有自己的声音。</p>
        </div>
        <div className="aside-bottom">
          <span className="workspace-avatar">D</span>
          <div>
            本地工作空间<small>DobStudio / Beta 2.0</small>
          </div>
          <span className="dot" />
        </div>
      </aside>
      <main>
        <header className="app-header">
          <div className="breadcrumb">
            <span>工作空间</span>
            <span>/</span>
            <strong>{descriptions[route]}</strong>
          </div>
          <div className="header-right">
            <button
              className="header-search"
              onClick={() =>
                leave(() => {
                  setRoute("projects");
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLInputElement>("[data-project-search]")
                      ?.focus(),
                  );
                })
              }
            >
              <Icon name="search" size={16} />
              <span>搜索项目</span>
              <kbd>Ctrl K</kbd>
            </button>
            <span className="header-divider" />
            <span className="edition">STANDARD</span>
            <span className="profile-avatar">D</span>
          </div>
        </header>
        <div className={`page-content route-${route}`}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {route === "projects"
                  ? "GOOD IDEAS START HERE"
                  : `STUDIO / ${route.toUpperCase()}`}
              </div>
              <h1>
                {descriptions[route]}
                <span className="heading-dot">.</span>
              </h1>
            </div>
            {route !== "projects" && (
              <label className="project-select">
                <span>当前项目</span>
                <select
                  aria-label="当前项目"
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
              </label>
            )}
            {route === "projects" && (
              <span className="heading-caption">
                A space for your next great story.
              </span>
            )}
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button
                className="icon-button"
                aria-label="关闭错误提示"
                onClick={() => setError("")}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {message && (
            <div className="notice" role="status">
              <Icon name="check" size={16} />
              {message}
            </div>
          )}
          {route === "projects" && (
            <ProjectsView
              projects={snapshot.projects}
              jobs={snapshot.jobs}
              open={(id) =>
                leave(() => {
                  setSelected(id);
                  setRoute("subtitles");
                })
              }
              importMedia={importMedia}
              importUrl={() => {
                setError("");
                linkDialog.current?.showModal();
              }}
            />
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
            <div className="panel task-panel">
              <div className="task-heading">
                <div>
                  <h2>创作进程</h2>
                  <p className="muted">从每一次开始，到每一份成片。</p>
                </div>
                <span className="badge">{activeCount} 项进行中</span>
              </div>
              {snapshot.jobs.map((j) => (
                <div className="job" key={j.id}>
                  <span className={`job-icon ${j.status}`}>
                    <Icon
                      name={
                        j.kind === "dubbing"
                          ? "wave"
                          : j.kind === "export-video"
                            ? "film"
                            : "captions"
                      }
                    />
                  </span>
                  <div>
                    <b>
                      {
                        snapshot.projects.find((p) => p.id === j.projectId)
                          ?.name
                      }{" "}
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
                          {artifact.label}
                          <Icon name="arrow" size={14} />
                        </button>
                      ))}
                    </div>
                  </div>
                  <span className={`badge ${j.status}`}>
                    {
                      {
                        queued: "排队中",
                        running: "运行中",
                        done: "已完成",
                        failed: "失败",
                        cancelled: "已取消",
                      }[j.status]
                    }
                  </span>
                  {["queued", "running"].includes(j.status) && (
                    <button onClick={() => void act(() => api.cancel(j.id))}>
                      取消
                    </button>
                  )}
                </div>
              ))}
              {!snapshot.jobs.length && (
                <div className="library-empty">
                  <div className="empty-glyph">
                    <Icon name="layers" size={28} />
                  </div>
                  <h3>好作品，值得一点等待。</h3>
                  <p>提交字幕或配音任务后，在这里查看进度与输出。</p>
                </div>
              )}
            </div>
          )}
          {route === "settings" && (
            <SettingsPanel settings={snapshot.settings} act={act} />
          )}
          <footer className="page-footer">
            <span>
              DOBSTUDIO <i> / </i> MADE FOR YOUR FLOW
            </span>
            <span>
              <i className="dot" />
              本地工作空间
            </span>
          </footer>
        </div>
      </main>
      <dialog
        ref={linkDialog}
        className="import-dialog"
        aria-label="从链接导入项目"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (importing || !source.trim()) return;
            setImporting(true);
            void create(source.trim()).finally(() => setImporting(false));
          }}
        >
          <div className="dialog-heading">
            <span className="empty-glyph">
              <Icon name="link" size={24} />
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭导入窗口"
              onClick={() => linkDialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="eyebrow">IMPORT FROM THE WEB</div>
          <h2>把灵感带进工作室。</h2>
          <p className="muted">粘贴视频链接，创建一个新项目。</p>
          <label>
            视频链接
            <input
              autoFocus
              type="url"
              required
              placeholder="https://…"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={importing || !source.trim()}>
            {importing ? "正在创建…" : "创建项目"}
            <Icon name="arrow" />
          </button>
        </form>
      </dialog>
    </div>
  );
}
