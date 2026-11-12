import type { CSSProperties } from "react";
const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  captions:
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 10h4 M7 14h4 M15 10h2 M15 14h2",
  wave: "M3 10v4 M7 6v12 M12 3v18 M17 7v10 M21 10v4",
  layers: "m12 3 10 5-10 5L2 8z M2 12l10 5 10-5 M2 16l10 5 10-5",
  settings:
    "M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  plus: "M12 5v14 M5 12h14",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  upload: "M12 16V3 M7 8l5-5 5 5 M4 15v5h16v-5",
  search: "M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M15 15l6 6",
  link: "m10 14 4-4 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  film: "M3 4h18v16H3z M7 4v16 M17 4v16 M3 9h4 M3 15h4 M17 9h4 M17 15h4",
  close: "m6 6 12 12 M18 6 6 18",
  check: "m5 12 4 4L19 6",
  list: "M8 6h13 M8 12h13 M8 18h13 M3 6h.1 M3 12h.1 M3 18h.1",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2",
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function SignalScene() {
  return (
    <div className="signal-scene" aria-hidden="true">
      <div className="signal-halo" />
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="orbit orbit-three" />
      <div className="signal-core">
        <div className="signal-bars">
          {Array.from({ length: 37 }, (_, i) => (
            <i
              key={i}
              style={
                {
                  "--height": `${18 + Math.pow(Math.sin(i * 0.49), 2) * 78 * (1 - Math.abs(i - 18) / 24)}px`,
                  "--delay": `${-i * 0.13}s`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      </div>
      <div className="floating-chip chip-caption">
        <Icon name="captions" />
        语言，让世界靠近<span>字幕</span>
      </div>
      <div className="floating-chip chip-wave">
        <Icon name="wave" />
        Every voice. Reimagined.<span>声音</span>
      </div>
      <div className="scene-coordinate">AUDIO × LANGUAGE × MOTION</div>
    </div>
  );
}
