import { useState } from "react";
import type { Project, Job } from "@dobstudio/core/studio";
import { Icon, PrismScene } from "../visuals";
import { readEditingPosition, timecode } from "../editingPosition";
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
  const position = readEditingPosition();
  const featured =
    projects.find((p) => p.id === position?.projectId) ?? projects[0];
  const cue =
    featured?.cues[
      Math.min(
        position?.projectId === featured.id ? position.cueIndex : 0,
        Math.max(0, featured.cues.length - 1),
      )
    ];
  return (
    <>
      <div className="creation-deck">
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">DOBSTUDIO</div>
            <h2>
              留住灵感。
              <br />
              <span>完成好作品。</span>
            </h2>
            <p>把创作交给你。其余的，在这里完成。</p>
            <div className="hero-actions">
              <button className="primary" onClick={importMedia}>
                <Icon name="plus" />
                新建项目
                <Icon name="arrow" />
              </button>
              <button className="text-button" onClick={importUrl}>
                <Icon name="link" />
                链接导入
              </button>
            </div>
          </div>
          <PrismScene />
        </section>
        <section className="resume-card" aria-label="继续编辑">
          <div className="resume-heading">
            <span>{featured ? "继续上次的创作" : "你的工作空间"}</span>
            <Icon name="clock" size={16} />
          </div>
          <div className="resume-art" aria-hidden="true">
            <div />
            <Icon name="film" size={28} />
          </div>
          {featured ? (
            <>
              <h3 title={featured.name}>{featured.name}</h3>
              <p className="resume-position">
                {cue
                  ? `第 ${cue.index} 段 · ${timecode(cue.startMs)}`
                  : "尚未添加字幕"}
              </p>
              <button
                className="continue-button"
                onClick={() => open(featured.id)}
              >
                继续编辑
                <Icon name="arrow" size={16} />
              </button>
            </>
          ) : (
            <>
              <h3>第一份作品，就从这里开始。</h3>
              <p className="resume-position">视频与音频，随时加入。</p>
              <button className="continue-button" onClick={importMedia}>
                选择文件
                <Icon name="arrow" size={16} />
              </button>
            </>
          )}
        </section>
      </div>
      <section className="library-section" aria-label="项目库">
        <div className="library-heading">
          <div>
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
              <b>新建项目</b>
              <small>导入新的视频或音频</small>
            </button>
          )}
        </div>
        {!filtered.length && (
          <div className="library-empty">
            <div className="empty-glyph">
              <Icon name={projects.length ? "search" : "film"} size={28} />
            </div>
            <h3>{projects.length ? "没有找到匹配的项目" : "还没有项目"}</h3>
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
