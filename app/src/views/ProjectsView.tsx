import { useState } from "react";
import type { Project, Job } from "@dobstudio/core/studio";
import { Icon, SignalScene } from "../visuals";
export function ProjectsView({
  projects,
  jobs,
  open,
  importMedia,
  importUrl,
}: {
  projects: Project[];
  jobs: Job[];
  open: (id: string) => void;
  importMedia: () => void;
  importUrl: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "subtitles" | "outputs">("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const outputIds = new Set(
    jobs.filter((j) => j.status === "done").map((j) => j.projectId),
  );
  const filtered = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "subtitles" ? p.cues.length > 0 : outputIds.has(p.id))),
  );
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="live-dot" /> THE CREATIVE WORKSPACE
          </div>
          <h2>
            每一种声音，
            <br />
            <span>都有新的可能。</span>
          </h2>
          <p>
            从第一帧画面，到另一种语言。
            <br />
            在这里，让字幕、声音和影像一起流动。
          </p>
          <div className="hero-actions">
            <button className="primary" onClick={importMedia}>
              <Icon name="plus" />
              创建新项目
              <Icon name="arrow" />
            </button>
            <button className="text-button" onClick={importUrl}>
              <Icon name="link" />
              从链接导入
            </button>
          </div>
          <div className="hero-footnote">
            <span>01 / 导入影像</span>
            <i />
            <span>02 / 编排语言</span>
            <i />
            <span>03 / 赋予声音</span>
          </div>
        </div>
        <SignalScene />
      </section>
      <div className="workspace-summary">
        <div>
          <Icon name="film" />
          <span>项目总数</span>
          <b>{projects.length.toString().padStart(2, "0")}</b>
        </div>
        <div>
          <Icon name="captions" />
          <span>字幕片段</span>
          <b>
            {projects
              .reduce((sum, p) => sum + p.cues.length, 0)
              .toLocaleString()}
          </b>
        </div>
        <div>
          <Icon name="layers" />
          <span>进行中的任务</span>
          <b>
            {jobs
              .filter((j) => j.status === "running" || j.status === "queued")
              .length.toString()
              .padStart(2, "0")}
          </b>
        </div>
        <span className="summary-note">YOUR IDEAS, IN MOTION.</span>
      </div>
      <section className="library-section" aria-label="项目库">
        <div className="library-heading">
          <div>
            <div className="eyebrow">YOUR LIBRARY</div>
            <h2>
              最近项目 <span>{projects.length}</span>
            </h2>
          </div>
          <div className="library-tools">
            <label className="search-field">
              <Icon name="search" />
              <input
                data-project-search
                aria-label="搜索项目"
                placeholder="搜索项目…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>Ctrl K</kbd>
            </label>
            <div className="view-switch">
              <button
                aria-label="网格视图"
                aria-pressed={view === "grid"}
                onClick={() => setView("grid")}
              >
                <Icon name="grid" size={16} />
              </button>
              <button
                aria-label="列表视图"
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <Icon name="list" size={17} />
              </button>
            </div>
          </div>
        </div>
        <div className="library-filters">
          {(
            [
              ["all", "全部项目"],
              ["subtitles", "已有字幕"],
              ["outputs", "已有输出"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
          <span>按创建顺序</span>
        </div>
        <div
          className={`project-grid ${view === "list" ? "project-list" : ""}`}
        >
          {filtered.map((p, i) => (
            <button
              className={`project-card art-${i % 4}`}
              key={p.id}
              onClick={() => open(p.id)}
            >
              <div className="project-art">
                <div className="art-rings" />
                <Icon name="film" size={28} />
                <span className="project-type">
                  {p.cues.length ? "SUBTITLED" : "SOURCE"}
                </span>
                <span className="project-open">
                  <Icon name="arrow" />
                </span>
              </div>
              <div className="project-card-copy">
                <h3 title={p.name}>{p.name}</h3>
                <small>
                  {p.cues.length} 条字幕
                  <span>修订 {p.revision.toString().padStart(2, "0")}</span>
                </small>
              </div>
            </button>
          ))}
          {projects.length > 0 && !query && filter === "all" && (
            <button className="new-project-tile" onClick={importMedia}>
              <span>
                <Icon name="plus" size={22} />
              </span>
              <b>下一个灵感，从这里开始</b>
              <small>导入新的视频或音频</small>
            </button>
          )}
        </div>
        {!filtered.length && (
          <div className="library-empty">
            <div className="empty-glyph">
              <Icon name={projects.length ? "search" : "film"} size={28} />
            </div>
            <h3>
              {projects.length
                ? "没有找到匹配的项目"
                : "为你的第一个作品，留好位置。"}
            </h3>
            <p>
              {projects.length
                ? "试试其他关键词或筛选条件。"
                : "导入一段视频，开始你的创作。"}
            </p>
            {!projects.length && (
              <button className="text-button" onClick={importMedia}>
                选择本地文件
                <Icon name="arrow" size={15} />
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
