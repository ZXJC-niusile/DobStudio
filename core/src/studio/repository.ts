import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  validateSettings,
  type Project,
  type Job,
  type Settings,
} from "./contracts.ts";
export class Repository {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), body TEXT NOT NULL, request TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);`);
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT body FROM projects ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(String(r.body)));
  }
  project(id: string): Project {
    const row = this.db.prepare("SELECT body FROM projects WHERE id=?").get(id);
    if (!row) throw new Error("Project not found");
    return JSON.parse(String(row.body));
  }
  create(source: string): Project {
    const p: Project = {
      id: randomUUID(),
      name: source.split(/[\\/]/).pop() || source,
      source,
      revision: 0,
      cues: [],
    };
    this.db
      .prepare("INSERT INTO projects VALUES(?,?)")
      .run(p.id, JSON.stringify(p));
    return p;
  }
  save(p: Project): void {
    this.db
      .prepare("UPDATE projects SET body=? WHERE id=?")
      .run(JSON.stringify(p), p.id);
  }
  jobs(): Job[] {
    return this.db
      .prepare("SELECT body FROM jobs ORDER BY rowid DESC")
      .all()
      .map((r) => JSON.parse(String(r.body)));
  }
  insert(j: Job, request: unknown): void {
    this.db
      .prepare("INSERT INTO jobs VALUES(?,?,?,?)")
      .run(j.id, j.projectId, JSON.stringify(j), JSON.stringify(request));
  }
  update(j: Job): void {
    this.db
      .prepare("UPDATE jobs SET body=? WHERE id=?")
      .run(JSON.stringify(j), j.id);
  }
  settings(): Settings {
    const r = this.db.prepare("SELECT body FROM settings WHERE id=1").get();
    return r ? JSON.parse(String(r.body)) : { ...DEFAULT_SETTINGS };
  }
  saveSettings(s: Settings): void {
    validateSettings(s);
    this.db
      .prepare(
        "INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(JSON.stringify(s));
  }
  close(): void {
    this.db.close();
  }
}
