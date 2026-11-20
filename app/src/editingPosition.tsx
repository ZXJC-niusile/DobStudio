import type { BilingualCue } from "@dobstudio/core";
const storageKey = "dobstudio.editing-position";
interface EditingPosition {
  projectId: string;
  cueIndex: number;
}
export function readEditingPosition(): EditingPosition | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (
      p &&
      typeof p.projectId === "string" &&
      Number.isInteger(p.cueIndex) &&
      p.cueIndex >= 0
    )
      return p;
  } catch {
    /* Storage may be unavailable. */
  }
}
export function rememberEditingPosition(projectId: string, cueIndex = 0) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ projectId, cueIndex }));
  } catch {
    /* Editing remains available without local preferences. */
  }
}
export function timecode(ms: number) {
  const total = Math.max(0, Math.floor(ms));
  return `${String(Math.floor(total / 3600000)).padStart(2, "0")}:${String(Math.floor(total / 60000) % 60).padStart(2, "0")}:${String(Math.floor(total / 1000) % 60).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`;
}
export function TrackStrip({
  cues,
  selected,
  select,
}: {
  cues: BilingualCue[];
  selected: number;
  select: (index: number) => void;
}) {
  const end = cues.reduce((last, cue) => Math.max(last, cue.endMs), 1);
  const stride = Math.max(1, Math.ceil(cues.length / 160));
  const clips = Array.from(
    { length: Math.ceil(cues.length / stride) },
    (_, group) => {
      const index = group * stride;
      const lastIndex = Math.min(cues.length - 1, index + stride - 1);
      return {
        cue: cues[index]!,
        index,
        lastIndex,
        endMs: cues[lastIndex]!.endMs,
      };
    },
  );
  return (
    <div className="track-strip">
      <div className="track-ruler">
        <span>00:00</span>
        <span>{timecode(end)}</span>
      </div>
      <div className="track-row">
        <div className="track-bed">
          {clips.map(({ cue, index: i, lastIndex, endMs }) => (
            <button
              key={cue.index}
              className={`track-clip ${selected >= i && selected <= lastIndex ? "selected" : ""}`}
              style={{
                left: `${(cue.startMs / end) * 100}%`,
                width: `${((endMs - cue.startMs) / end) * 100}%`,
              }}
              onClick={() => select(i)}
              aria-label={`定位第 ${i + 1} 条字幕`}
              title={`${timecode(cue.startMs)} · ${cue.text}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
