/**
 * Resumable jobs.
 *
 * A two-hour video takes tens of minutes to transcribe, and an app that throws
 * all of that away when it is closed mid-run is not usable. The checkpoint is
 * deliberately dumb: one row per finished stage, recording the artifact it
 * produced. On a restart the pipeline asks which stages are already done and
 * skips them.
 *
 * What makes a checkpoint valid is the *fingerprint* — a hash of everything
 * that would change the output. A different model, a different target language
 * or a different provider invalidates the cached stage, because reusing it
 * would silently mix two different runs' work.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import type { PipelineRequest, PipelineStage } from "./types.ts";

/** Stages whose output is a file that can be reused on a restart. */
export const RESUMABLE_STAGES: readonly PipelineStage[] = [
  "probing",
  "downloading",
  "extracting-audio",
  "transcribing",
  "translating",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  job_key     TEXT NOT NULL,
  stage       TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  artifact    TEXT,
  detail      TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (job_key, stage)
);
CREATE INDEX IF NOT EXISTS checkpoints_key ON checkpoints(job_key);
`;

export interface Checkpoint {
  stage: PipelineStage;
  fingerprint: string;
  artifact?: string;
  detail?: string;
}

/**
 * Everything about a request that changes what a stage produces.
 *
 * The URL alone is not enough: the same video transcribed with `tiny` and with
 * `large-v3-turbo` must not share a transcript checkpoint.
 */
export function fingerprint(request: PipelineRequest): string {
  const relevant = {
    url: request.url,
    quality: request.download.quality,
    container: request.download.container,
    subLangs: [...request.download.subLangs].sort(),
    writeSubs: request.download.writeSubs,
    asrModel: request.transcribe.model,
    asrLang: request.transcribe.lang ?? null,
    targetLang: request.targetLang ?? null,
    sourceLang: request.sourceLang ?? null,
    provider: request.provider
      ? {
          baseUrl: request.provider.baseUrl,
          model: request.provider.model,
          concurrency: request.provider.concurrency ?? 4,
        }
      : null,
    glossary: (request.glossary ?? [])
      .map((entry) => `${entry.source}=${entry.target}`)
      .sort(),
    splitLongLines: request.render.splitLongLines,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 32);
}

/** Stable key for a request, independent of run-to-run details. */
export function jobKey(request: PipelineRequest): string {
  return `${fingerprint(request)}`;
}

export class CheckpointStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /** Record a finished stage. */
  save(key: string, checkpoint: Checkpoint): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints (job_key, stage, fingerprint, artifact, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_key, stage) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           artifact = excluded.artifact,
           detail = excluded.detail,
           created_at = excluded.created_at`,
      )
      .run(
        key,
        checkpoint.stage,
        checkpoint.fingerprint,
        checkpoint.artifact ?? null,
        checkpoint.detail ?? null,
        Date.now(),
      );
  }

  /**
   * Stages already done for this exact request.
   *
   * A checkpoint whose artifact no longer exists on disk is dropped, because a
   * deleted download cannot be resumed from.
   */
  completed(key: string, fingerprint: string): Map<PipelineStage, Checkpoint> {
    const rows = this.db
      .prepare(`SELECT stage, fingerprint, artifact, detail FROM checkpoints WHERE job_key = ?`)
      .all(key) as { stage: string; fingerprint: string; artifact: string | null; detail: string | null }[];

    const out = new Map<PipelineStage, Checkpoint>();
    for (const row of rows) {
      if (row.fingerprint !== fingerprint) continue;
      if (row.artifact !== null && !existsSync(row.artifact)) continue;
      out.set(row.stage as PipelineStage, {
        stage: row.stage as PipelineStage,
        fingerprint: row.fingerprint,
        artifact: row.artifact ?? undefined,
        detail: row.detail ?? undefined,
      });
    }
    return out;
  }

  /** Remove one stage's checkpoint, forcing it to run again. */
  invalidate(key: string, stage: PipelineStage): void {
    this.db.prepare(`DELETE FROM checkpoints WHERE job_key = ? AND stage = ?`).run(key, stage);
  }

  /** Remove every checkpoint for a request. */
  clear(key: string): void {
    this.db.prepare(`DELETE FROM checkpoints WHERE job_key = ?`).run(key);
  }

  /** Drop checkpoints whose artifacts have disappeared. */
  prune(): number {
    const rows = this.db
      .prepare(`SELECT job_key, stage, artifact FROM checkpoints`)
      .all() as { job_key: string; stage: string; artifact: string | null }[];
    let removed = 0;
    for (const row of rows) {
      if (row.artifact !== null && !existsSync(row.artifact)) {
        this.db
          .prepare(`DELETE FROM checkpoints WHERE job_key = ? AND stage = ?`)
          .run(row.job_key, row.stage);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Which stages can be skipped, given what has already been done. */
export function resumePlan(
  completed: ReadonlyMap<PipelineStage, Checkpoint>,
): {
  skipProbe: boolean;
  skipDownload: boolean;
  skipAudio: boolean;
  mediaPath?: string;
  transcriptSrt?: string;
  translatedCount: number;
} {
  const probe = completed.get("probing");
  const download = completed.get("downloading");
  const audio = completed.get("extracting-audio");
  const transcribe = completed.get("transcribing");
  const translate = completed.get("translating");

  return {
    skipProbe: probe !== undefined,
    skipDownload: download !== undefined && download.artifact !== undefined,
    skipAudio: audio !== undefined && audio.artifact !== undefined,
    mediaPath: download?.artifact ?? audio?.artifact,
    transcriptSrt: transcribe?.artifact,
    translatedCount: translate?.detail !== undefined ? Number(translate.detail) || 0 : 0,
  };
}
