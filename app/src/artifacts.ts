export interface OutputArtifact {
  key: string;
  label: string;
  path: string;
}
const outputLabels: ReadonlyArray<readonly [string, string]> = [
  ["videoPathWithBgm", "混音视频（含伴奏）"],
  ["audioPathWithBgm", "混音音频（含伴奏）"],
  ["videoPath", "视频"],
  ["audioPath", "音频"],
  ["bgmPath", "分离伴奏"],
  ["assPath", "ASS 字幕"],
  ["srtPath", "SRT 字幕"],
];
export function outputArtifacts(
  result?: Record<string, unknown>,
): OutputArtifact[] {
  if (!result) return [];
  const mixed =
    typeof result.videoPathWithBgm === "string" ||
    typeof result.audioPathWithBgm === "string";
  return outputLabels.flatMap(([key, label]) =>
    typeof result[key] === "string" && result[key]
      ? [
          {
            key,
            path: result[key] as string,
            label:
              mixed && key === "videoPath"
                ? "干声视频（无伴奏）"
                : mixed && key === "audioPath"
                  ? "干声音频（无伴奏）"
                  : label,
          },
        ]
      : [],
  );
}
