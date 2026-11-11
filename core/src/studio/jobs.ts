import { randomUUID } from "node:crypto";
import type { BilingualCue } from "../types.ts";
import {
  resolveDubbingConfig,
  validateCues,
  validateTask,
  type Job,
  type Project,
  type Settings,
  type TaskRequest,
} from "./contracts.ts";
import type { Repository } from "./repository.ts";
export interface TaskContext {
  jobId: string;
  project: Project;
  settings: Settings;
  request: TaskRequest;
  inputVideo?: string;
  signal: AbortSignal;
  progress: (stage: string) => void;
}
export interface TaskResult {
  artifacts: Record<string, unknown>;
  cues?: BilingualCue[];
  source?: string;
}
export type Executor = (context: TaskContext) => Promise<TaskResult>;
interface Pending {
  job: Job;
  context: TaskContext;
  controller: AbortController;
}
/** The sole admission and lifecycle owner. One job at a time bounds GPU/media I/O. */
export class Jobs {
  private queue: Pending[] = [];
  private active?: Pending;
  private closed = false;
  private idleWaiters: (() => void)[] = [];
  private repo: Repository;
  private execute: Executor;
  private changed: () => void;
  constructor(
    repo: Repository,
    execute: Executor,
    changed: () => void = () => {},
  ) {
    this.repo = repo;
    this.execute = execute;
    this.changed = changed;
    for (const j of repo.jobs())
      if (j.status === "running" || j.status === "queued")
        repo.update({
          ...j,
          status: "failed",
          stage: "interrupted",
          error: "Application closed before task completed. Submit again.",
        });
  }
  busy(id: string): boolean {
    return (
      this.active?.job.projectId === id ||
      this.queue.some((p) => p.job.projectId === id)
    );
  }
  save(id: string, revision: number, cues: BilingualCue[]): Project {
    if (this.busy(id)) throw new Error("Project has a queued or running task");
    validateCues(cues);
    const p = this.repo.project(id);
    if (p.revision !== revision)
      throw new Error("Subtitles changed; reload before saving");
    const updated = {
      ...p,
      cues: structuredClone(cues),
      revision: revision + 1,
    };
    this.repo.save(updated);
    this.changed();
    return updated;
  }
  submit(id: string, request: TaskRequest): string {
    if (this.closed) throw new Error("Application is closing");
    validateTask(request);
    if (this.busy(id))
      throw new Error("Project already has a queued or running task");
    const project = this.repo.project(id),
      settings = this.repo.settings();
    let inputVideo: string | undefined;
    if (request.kind === "export-video") {
      validateCues(project.cues);
      if (!project.cues.length)
        throw new Error("Add subtitles before exporting");
      inputVideo = project.source;
      if (
        request.options.audioSource === "dubbing" ||
        request.options.audioSource === "dubbing-with-bgm"
      ) {
        const needsBgm = request.options.audioSource === "dubbing-with-bgm";
        const current = this.repo
          .jobs()
          .find(
            (j) =>
              j.projectId === id &&
              j.kind === "dubbing" &&
              j.status === "done" &&
              j.result?.projectRevision === project.revision &&
              (needsBgm
                ? typeof j.result.videoPathWithBgm === "string" ||
                  (j.result.backgroundAudio === "included" &&
                    typeof j.result.videoPath === "string")
                : typeof j.result.videoPath === "string"),
          );
        if (!current)
          throw new Error(
            needsBgm
              ? "No dubbing with background audio matches this subtitle revision. Generate dubbing again before export."
              : "No dubbing matches this subtitle revision. Generate dubbing again before export.",
          );
        inputVideo = String(
          needsBgm
            ? (current.result!.videoPathWithBgm ?? current.result!.videoPath)
            : current.result!.videoPath,
        );
      }
    } else if (request.kind === "dubbing") {
      validateCues(project.cues);
      if (
        !project.cues.length ||
        project.cues.some((c) => !c.translation?.trim())
      )
        throw new Error("Translate every cue before dubbing");
      resolveDubbingConfig(settings, request.options);
    } else if (
      request.kind === "subtitles" &&
      request.options.targetLang &&
      !settings.provider
    )
      throw new Error("Configure a translation provider first");
    const job: Job = {
      id: randomUUID(),
      projectId: id,
      kind: request.kind,
      status: "queued",
      stage: "queued",
    };
    const controller = new AbortController();
    const context: TaskContext = {
      jobId: job.id,
      project: structuredClone(project),
      inputVideo,
      settings: structuredClone(settings),
      request: structuredClone(request),
      signal: controller.signal,
      progress: (stage) => {
        job.stage = stage;
        this.repo.update(job);
        this.changed();
      },
    };
    // Never persist API secrets in task snapshots.
    this.repo.insert(job, {
      project,
      request,
      settings: {
        ...settings,
        provider: settings.provider
          ? { ...settings.provider, apiKey: "" }
          : undefined,
      },
    });
    this.queue.push({ job, context, controller });
    this.changed();
    void this.pump();
    return job.id;
  }
  cancel(id: string): void {
    if (this.active?.job.id === id) {
      this.active.controller.abort();
      this.active.job.stage = "cancelling";
      this.repo.update(this.active.job);
    }
    const i = this.queue.findIndex((p) => p.job.id === id);
    if (i >= 0) {
      const [p] = this.queue.splice(i, 1);
      if (p) {
        p.job.status = "cancelled";
        p.job.stage = "cancelled";
        this.repo.update(p.job);
      }
    }
    this.changed();
  }
  private async pump(): Promise<void> {
    if (this.active) return;
    const p = this.queue.shift();
    if (!p) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
      return;
    }
    this.active = p;
    p.job.status = "running";
    this.repo.update(p.job);
    this.changed();
    try {
      const result = await this.execute(p.context);
      p.controller.signal.throwIfAborted();
      if (result.cues) validateCues(result.cues);
      const current = this.repo.project(p.job.projectId);
      if (current.revision !== p.context.project.revision)
        throw new Error("Project changed during task");
      if (result.cues || result.source)
        this.repo.save({
          ...current,
          cues: result.cues ?? current.cues,
          source: result.source ?? current.source,
          revision: current.revision + 1,
        });
      p.job.status = "done";
      p.job.stage = "done";
      p.job.result = {
        ...result.artifacts,
        projectRevision: this.repo.project(p.job.projectId).revision,
      };
    } catch (e) {
      p.job.status = p.controller.signal.aborted ? "cancelled" : "failed";
      p.job.stage = p.job.status;
      p.job.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.repo.update(p.job);
      this.active = undefined;
      this.changed();
      void this.pump();
    }
  }
  idle(): Promise<void> {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const p of [...this.queue]) this.cancel(p.job.id);
    if (this.active) this.cancel(this.active.job.id);
    await this.idle();
  }
}
