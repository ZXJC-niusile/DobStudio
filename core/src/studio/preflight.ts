import { run } from "../proc.ts";
import {
  resolveDubbingConfig,
  type Settings,
  type DubOptions,
} from "./contracts.ts";

/** Check the configured interpreter before admitting a model task. No weights are loaded. */
export async function checkDubbingRuntime(
  settings: Settings,
  options: DubOptions,
  engineRoot: string,
): Promise<void> {
  const { engine, modelPath } = resolveDubbingConfig(settings, options);
  const args = [
    "-m",
    "dobstudio_engine",
    "--preflight",
    "--engine",
    engine,
    "--model-path",
    modelPath,
  ];
  if (options.separateBgm) args.push("--separate-bgm");
  const check = await run(settings.python, args, {
    cwd: engineRoot,
    timeoutMs: 30000,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  let result: { version?: number; type?: string; message?: string } = {};
  try {
    result = JSON.parse(check.stdout);
  } catch {
    /* Include diagnostics below. */
  }
  if (
    check.code !== 0 ||
    check.timedOut ||
    result.version !== 1 ||
    result.type !== "ready"
  )
    throw new Error(
      result.message ||
        check.stderr.slice(-2000) ||
        "Python runtime check failed",
    );
}
