import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  run,
  Sidecar,
  parseSrt,
  serializeSrt,
  toFlatBilingual,
} from "@dobstudio/core";
import {
  checkDubbingRuntime,
  validateTask,
  Repository,
  Jobs,
  createExecutor,
  type DesktopApi,
} from "@dobstudio/core/studio";
const here = dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes("--smoke");
app.setName("DobStudio");
if (smoke)
  app.setPath("userData", mkdtempSync(join(tmpdir(), "dobstudio-smoke-")));
let window: BrowserWindow | undefined;
let repository: Repository;
let jobs: Jobs;
let closing = false;
function notify(): void {
  if (window && !window.isDestroyed())
    window.webContents.send("studio:changed");
}
function register<K extends keyof Omit<DesktopApi, "onChange">>(
  name: K,
  handler: DesktopApi[K],
): void {
  ipcMain.handle(`studio:${name}`, (event, ...args) => {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Untrusted sender");
    return (handler as (...args: unknown[]) => unknown)(...args);
  });
}
app
  .whenReady()
  .then(async () => {
    const root = app.getPath("userData");
    const sidecar = new Sidecar({ binDir: join(root, "runtime") });
    repository = new Repository(join(root, "studio.sqlite"));
    const engine = app.isPackaged
      ? join(process.resourcesPath, "engine")
      : resolve(here, "../../engine");
    jobs = new Jobs(repository, createExecutor(root, engine, sidecar), notify);
    register("snapshot", async () => ({
      projects: repository.projects(),
      jobs: repository.jobs(),
      settings: repository.settings(),
    }));
    register("createProject", async (source) => {
      if (typeof source !== "string" || !source.trim())
        throw new Error("Choose a file or enter a URL");
      if (!existsSync(source) && !/^https?:\/\//i.test(source))
        throw new Error("Media file does not exist");
      const project = repository.create(source.trim());
      notify();
      return project;
    });
    register("saveCues", async (id, revision, cues) =>
      jobs.save(id, revision, cues),
    );
    register("importSrt", async (id, revision) => {
      const pick = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "Subtitles", extensions: ["srt"] }],
      });
      const path = pick.filePaths[0];
      if (!path) return null;
      return jobs.save(
        id,
        revision,
        parseSrt(await readFile(path, "utf8")).map((c, i) => ({
          ...c,
          index: i + 1,
        })),
      );
    });
    register("mediaUrl", async (id) => {
      const source = repository.project(id).source;
      return existsSync(source) ? pathToFileURL(source).href : null;
    });
    register("exportSrt", async (id) => {
      const project = repository.project(id);
      const pick = await dialog.showSaveDialog({
        defaultPath: `${project.name}.srt`,
        filters: [{ name: "Subtitles", extensions: ["srt"] }],
      });
      if (!pick.filePath) return null;
      await writeFile(
        pick.filePath,
        serializeSrt(toFlatBilingual(project.cues)),
        "utf8",
      );
      return pick.filePath;
    });
    register("submit", async (id, request) => {
      if (installing)
        throw new Error("Wait for runtime installation to finish");
      validateTask(request);
      if (request.kind === "dubbing") {
        const settings = repository.settings();
        const revision = repository.project(id).revision;
        await checkDubbingRuntime(settings, request.options, engine);
        if (
          installing ||
          revision !== repository.project(id).revision ||
          JSON.stringify(settings) !== JSON.stringify(repository.settings())
        )
          throw new Error(
            "Project or settings changed during runtime check; submit again",
          );
      }
      return jobs.submit(id, request);
    });
    register("cancel", async (id) => jobs.cancel(id));
    register("saveSettings", async (settings) => {
      repository.saveSettings(settings);
      notify();
    });
    register("pick", async (kind) => {
      if (!["media", "reference", "model", "python"].includes(kind))
        throw new Error("Unknown picker");
      const pick = await dialog.showOpenDialog({
        properties: kind === "model" ? ["openDirectory"] : ["openFile"],
        filters:
          kind === "reference"
            ? [{ name: "PCM WAV", extensions: ["wav"] }]
            : undefined,
      });
      return pick.filePaths[0] ?? null;
    });
    register("reveal", async (path) => {
      if (typeof path !== "string" || !existsSync(path))
        throw new Error("Output not found");
      shell.showItemInFolder(path);
    });
    register("status", async () => sidecar.status());
    let installing = false;
    register("install", async (model) => {
      if (installing)
        throw new Error("Runtime installation already in progress");
      if (
        repository
          .jobs()
          .some((j) => j.status === "running" || j.status === "queued")
      )
        throw new Error(
          "Finish or cancel tasks before installing runtime tools",
        );
      if (
        ![
          "tiny",
          "base",
          "small",
          "medium",
          "large-v3",
          "large-v3-turbo",
        ].includes(model)
      )
        throw new Error("Unknown model");
      installing = true;
      try {
        for (const binary of [
          "ffmpeg",
          "ffprobe",
          "whisper",
          "yt-dlp",
        ] as const)
          await sidecar.ensureBinary(binary);
        await sidecar.ensureModel(model);
      } finally {
        installing = false;
        notify();
      }
    });
    window = new BrowserWindow({
      width: 1440,
      height: 930,
      minWidth: 1080,
      minHeight: 720,
      backgroundColor: "#0a0b12",
      show: !smoke,
      webPreferences: {
        preload: join(here, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: !smoke,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (e) => e.preventDefault());
    window.webContents.on("will-prevent-unload", (event) => {
      const choice = dialog.showMessageBoxSync(window!, {
        type: "question",
        buttons: ["继续编辑", "放弃修改并关闭"],
        defaultId: 0,
        cancelId: 0,
        message: "字幕尚未保存",
      });
      if (choice === 1) event.preventDefault();
    });
    const errors: string[] = [];
    window.webContents.on("preload-error", (_e, _path, error) =>
      errors.push(error.message),
    );
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") errors.push(event.message);
    });
    await window.loadFile(join(here, "../dist/index.html"));
    if (smoke) {
      try {
        const result = await window.webContents.executeJavaScript(`(async()=>{
    const delay=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<100&&!document.querySelector('[data-testid="studio-ready"]');i++)await delay(50);
    if(!window.dobstudio)throw Error('preload missing');
    if(!document.querySelector('[data-testid="studio-ready"]'))throw Error('renderer missing');
    for(const button of document.querySelectorAll('[data-route]')){button.click();await delay(70);}
    const p=await window.dobstudio.createProject('https://example.invalid/smoke.mp4');
    await window.dobstudio.saveCues(p.id,0,[{index:1,startMs:0,endMs:1000,text:'hello',translation:'你好'}]);
    const snapshot=await window.dobstudio.snapshot();
    if(snapshot.projects[0].revision!==1)throw Error('save not persisted');
    let refused=false;try{await window.dobstudio.submit(p.id,{kind:'dubbing',options:{referencePath:'',referenceText:'',referenceLanguage:'en',targetLanguage:'zh'}});}catch{refused=true;}
    if(!refused||(await window.dobstudio.snapshot()).jobs.length)throw Error('invalid request leaked job');
    const settings=(await window.dobstudio.snapshot()).settings;
    await window.dobstudio.saveSettings({...settings,xttsModelPath:'Z:/dobstudio-smoke-missing-model'});
    let preflightRejected=false;
    try{await window.dobstudio.submit(p.id,{kind:'dubbing',options:{engine:'xtts',referencePath:'ref.wav',referenceText:'',referenceLanguage:'en',targetLanguage:'en'}});}catch{preflightRejected=true;}
    if(!preflightRejected||(await window.dobstudio.snapshot()).jobs.length)throw Error('preflight failure leaked task');
    return {bridge:true,renderer:true,projectSave:true,validation:true,preflightRejected:true};
   })()`);
        const manifest = join(root, "worker-check.json");
        writeFileSync(
          manifest,
          JSON.stringify({
            version: 1,
            mediaPath: join(root, "source.mp4"),
            outputDir: join(root, "out"),
            referencePath: join(root, "ref.wav"),
            modelPath: join(root, "model"),
            ffmpeg: join(root, "ffmpeg.exe"),
            ffprobe: join(root, "ffprobe.exe"),
            device: "cpu",
            targetLanguage: "zh",
            referenceLanguage: "en",
            referenceText: "",
            cues: [
              {
                index: 1,
                startMs: 0,
                endMs: 1000,
                text: "hello",
                translation: "你好",
              },
            ],
          }),
        );
        const check = await run(
          process.env.DOBSTUDIO_PYTHON || "python",
          ["-m", "dobstudio_engine", "--check", "--manifest", manifest],
          {
            cwd: engine,
            timeoutMs: 30000,
            env: { ...process.env, PYTHONUTF8: "1" },
          },
        );
        if (check.code !== 0 || JSON.parse(check.stdout).type !== "validated")
          throw new Error("Packaged worker check failed: " + check.stderr);
        result.workerProtocol = true;
        const ok = errors.length === 0;
        const report = { ok, ...result, errors };
        const destination =
          process.env.DOBSTUDIO_SMOKE_REPORT || join(root, "smoke-result.json");
        writeFileSync(destination, JSON.stringify(report, null, 2));
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-route="projects"]').click()`,
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        writeFileSync(
          destination.replace(/\.json$/, ".png"),
          (await window.webContents.capturePage()).toPNG(),
        );
        console.log(JSON.stringify(report));
        process.exitCode = ok ? 0 : 1;
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (closing) return;
  event.preventDefault();
  if (window && !window.isDestroyed()) {
    window.close();
    return;
  }
  closing = true;
  void (async () => {
    await jobs?.close();
    repository?.close();
    app.exit(process.exitCode ? Number(process.exitCode) : 0);
  })();
});
