/**
 * Cover-art extraction.
 *
 * A library without covers is a wall of filenames. Two sources, in order of
 * preference:
 *
 *  1. The URL yt-dlp already reported in the video metadata — no extra work.
 *  2. A frame pulled out of the media with ffmpeg, for local files and for
 *     sources that carry no thumbnail.
 *
 * Both are best-effort: a missing cover is cosmetic, so every failure path
 * returns `undefined` rather than throwing.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { run } from "./proc.ts";
import type { Sidecar } from "./sidecar.ts";
import type { MediaMeta } from "./types.ts";

/** Suggested cover path for a media file. */
export function coverPathFor(mediaPath: string): string {
  const dot = mediaPath.lastIndexOf(".");
  const slash = Math.max(mediaPath.lastIndexOf("\\"), mediaPath.lastIndexOf("/"));
  const stem = dot > slash ? mediaPath.slice(0, dot) : mediaPath;
  return `${stem}.cover.jpg`;
}

/**
 * Fetch a cover image, preferring the source's own thumbnail.
 *
 * Returns the path written, or `undefined` when neither source produced one.
 */
export async function fetchCover(
  sidecar: Sidecar,
  mediaPath: string,
  meta: MediaMeta,
  signal?: AbortSignal,
  outputDir?: string,
): Promise<string | undefined> {
  const destination = outputDir ? join(outputDir, basename(coverPathFor(mediaPath))) : coverPathFor(mediaPath);
  if (existsSync(destination)) return destination;

  // 1 — the URL from the metadata.
  if (meta.thumbnailUrl !== undefined && meta.thumbnailUrl !== "") {
    try {
      const response = await fetch(meta.thumbnailUrl, {
        signal,
        redirect: "follow",
        headers: { "User-Agent": "dobstudio/0.1" },
      });
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        // A tiny or non-image body means an error page, not a thumbnail.
        if (bytes.byteLength > 1024 && looksLikeImage(bytes)) {
          await writeFile(destination, bytes);
          return destination;
        }
      }
    } catch {
      // Fall through to ffmpeg.
    }
  }

  // 2 — a frame from the media itself.
  try {
    await mkdir(dirname(destination), { recursive: true });
    const result = await sidecar.run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        "1",
        "-i",
        mediaPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        "-q:v",
        "3",
        destination,
      ],
      { timeoutMs: 120_000, signal },
    );
    if (result.code === 0 && existsSync(destination)) return destination;
  } catch {
    // No cover, which is fine.
  }

  return undefined;
}

/** Cheap magic-number check, so an HTML error page is not mistaken for a JPEG. */
function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  // PNG
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }
  // WebP
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return true;
  }
  return false;
}

/** Human-readable label for a media file, used in the library list. */
export function coverLabel(mediaPath: string): string {
  return basename(mediaPath).replace(/\.[^.]+$/, "");
}
