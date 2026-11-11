/**
 * Fake sidecar binaries, as Node scripts.
 *
 * The engine shells out to yt-dlp / ffmpeg / ffprobe / whisper-cli, and none of
 * them can be downloaded in CI or on a machine without a GPU and a model. These
 * scripts stand in for them: they accept the same arguments, print the same
 * shape of output, and write the same files, so `runPipeline` executes for real
 * — progress parsing, the source-subtitle shortcut, SRT round-tripping and
 * output writing are all genuinely exercised.
 *
 * What they do NOT do is process media. `ffmpeg` writes a WAV header it never
 * decodes into; `whisper-cli` returns a fixed transcript. That is the point:
 * the pipeline's own logic is what is under test.
 *
 * Selection is by `DOBSTUDIO_MOCK` in the environment, so one script covers all
 * four binaries.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Every invocation is logged, so a test can prove a binary was never called
 * rather than inferring it from the outcome.
 */
/**
 * Invocation log. The path comes from the environment so that parallel test
 * files do not write to — and then assert on — each other's records.
 */
const CALL_LOG =
  process.env.DOBSTUDIO_MOCK_CALL_LOG ?? join(tmpdir(), "dobstudio-mock-calls.log");
function record(binary, args) {
  try {
    appendFileSync(CALL_LOG, binary + " " + args.join(" ") + "\n");
  } catch {
    /* logging must never break the mock */
  }
}

const role = process.env.DOBSTUDIO_MOCK ?? "yt-dlp";
const argv = process.argv.slice(2);
record(role, argv);

/** Exit with a message on stderr, the way the real tools do. */
function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(1);
}

/** The canned transcript every mock run produces. */
const TRANSCRIPT = [
  { start: "00:00:01,000", end: "00:00:04,500", text: "So today we are going to talk about how neural networks actually learn." },
  { start: "00:00:04,500", end: "00:00:08,200", text: "And the key idea is gradient descent, which is just following the slope downhill." },
  { start: "00:00:08,200", end: "00:00:12,000", text: "You compute the gradient, take a small step, and repeat until you reach a minimum." },
  { start: "00:00:12,000", end: "00:00:16,400", text: "That is the whole algorithm. Everything else is engineering around it." },
];

switch (role) {
  /* ---------------------------------------------------------------- */
  case "yt-dlp": {
    if (argv.includes("--version")) {
      process.stdout.write("2026.11.04\n");
      break;
    }

    if (argv.includes("--dump-single-json")) {
      const url = argv[argv.length - 1] ?? "https://example.com/v";
      if (url.includes("fail-probe")) fail("Unable to extract video data");
      process.stdout.write(
        JSON.stringify({
          id: "mock123",
          title: "Mock Lecture — Gradient Descent",
          duration: 20,
          uploader: "Mock University",
          extractor_key: "Mock",
          webpage_url: url,
          thumbnail: "https://example.com/thumb.jpg",
          subtitles: { en: [{ ext: "srt", url: "https://example.com/en.srt" }] },
          automatic_captions: { "zh-Hans": [{ ext: "srt" }] },
          formats: [
            { format_id: "18", ext: "mp4", height: 360, filesize: 10_000_000 },
            { format_id: "137", ext: "mp4", height: 1080, filesize: 90_000_000, vcodec: "avc1", acodec: "none" },
            { format_id: "251", ext: "webm", abr: 130, acodec: "opus", vcodec: "none" },
          ],
        }),
      );
      break;
    }

    // A download run. Emit the progress lines the real tool emits, then write
    // the media file and, when subtitles were requested, an .en.srt beside it.
    const outputIndex = argv.indexOf("-o");
    const template = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
    if (!template) fail("no output template");
    const wantsSubs = argv.includes("--write-subs");

    const mediaName = "Mock Lecture - Gradient Descent-mock123.mp4";
    const destination = join(dirname(template.replace("%(id)s", "mock123").replace("%(title).100B", "Mock Lecture - Gradient Descent").replace("%(ext)s", "mp4")), mediaName);
    mkdirSync(dirname(destination), { recursive: true });

    process.stdout.write(`[youtube] mock123: Downloading webpage\n`);
    process.stdout.write(`[info] mock123: Downloading 1 format(s): 137+251\n`);
    for (const [percent, size, speed, eta] of [
      ["12.5", "11.25MiB", "4.20MiB/s", "00:19"],
      ["58.0", "52.20MiB", "4.55MiB/s", "00:08"],
      ["100.0", "90.00MiB", "4.31MiB/s", "00:00"],
    ]) {
      process.stdout.write(
        `[download]  ${percent}% of ${size} at ${speed} ETA ${eta}\n`,
      );
    }
    process.stdout.write(`[download] Destination: ${destination}\n`);
    process.stdout.write(`[Merger] Merging formats into "${destination}"\n`);
    writeFileSync(destination, Buffer.from("MOCK-MP4-DATA"));

    if (wantsSubs) {
      const srtPath = destination.replace(/\.mp4$/, ".en.srt");
      writeFileSync(
        srtPath,
        TRANSCRIPT.map((line, i) =>
          `${i + 1}\n${line.start} --> ${line.end}\n${line.text}\n`,
        ).join("\n"),
      );
    }
    break;
  }

  /* ---------------------------------------------------------------- */
  case "ffmpeg": {
    if (argv.includes("-version")) {
      process.stdout.write("ffmpeg version 7.1 Mock\n");
      break;
    }
    // `-i <in>` then the output path is the last argument.
    const output = argv[argv.length - 1];
    if (!output) fail("no output path");
    mkdirSync(dirname(output), { recursive: true });

    if (output.endsWith(".wav")) {
      // A 44-byte canonical RIFF/WAVE header: enough for `existsSync` checks
      // and for anything that only cares that the file exists.
      writeFileSync(output, Buffer.from("RIFF$WAVEfmt mock-data", "ascii"));
    } else {
      writeFileSync(output, Buffer.from("MOCK-CLIP-DATA"));
    }
    break;
  }

  /* ---------------------------------------------------------------- */
  case "ffprobe": {
    // `probeLocal` asks for JSON; the bare-duration call wants a plain number.
    if (argv.includes("-print_format")) {
      const silent = argv.some((a) => a.includes("silent"));
      process.stdout.write(
        JSON.stringify({
          format: { duration: "20.000000" },
          streams: silent ? [{ codec_type: "video" }] : [{ codec_type: "audio" }, { codec_type: "video" }],
        }),
      );
    } else {
      process.stdout.write("20.000000\n");
    }
    break;
  }

  /* ---------------------------------------------------------------- */
  case "whisper-cli": {
    const ofIndex = argv.indexOf("-of");
    const outputBase = ofIndex >= 0 ? argv[ofIndex + 1] : undefined;
    if (!outputBase) fail("no -of output base");
    mkdirSync(dirname(outputBase), { recursive: true });

    // Print segments as it goes, so progress parsing has something to chew on.
    for (const line of TRANSCRIPT) {
      process.stdout.write(
        `[${line.start.replace(",", ".")} --> ${line.end.replace(",", ".")}]  ${line.text}\n`,
      );
    }
    writeFileSync(
      `${outputBase}.srt`,
      TRANSCRIPT.map((line, i) =>
        `${i + 1}\n${line.start} --> ${line.end}\n${line.text}\n`,
      ).join("\n"),
    );
    break;
  }

  default:
    fail(`unknown mock role: ${role}`);
}

process.exit(0);
