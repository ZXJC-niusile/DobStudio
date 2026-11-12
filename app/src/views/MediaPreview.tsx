import { Icon } from "../visuals";
import { useEffect, useRef, useState } from "react";
import type { BilingualCue } from "@dobstudio/core";
import { api } from "../bridge";

/** Video player synced with project cues and subtitle timeline. */
export function MediaPreview({
  projectId,
  source,
  cues,
  seek,
}: {
  projectId: string;
  source: string;
  cues: BilingualCue[];
  seek: { ms: number; sequence: number } | null;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    setUrl(null);
    setPosition(0);
    setError("");
    void api
      .mediaUrl(projectId)
      .then((value) => {
        if (!disposed) setUrl(value);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [projectId, source]);
  useEffect(() => {
    if (video.current && seek) {
      video.current.currentTime = seek.ms / 1000;
      setPosition(seek.ms);
    }
  }, [seek]);
  const active = cues.find((c) => position >= c.startMs && position < c.endMs);
  return (
    <section className="media-preview" aria-label="视频预览">
      {url ? (
        <div className="video-stage">
          <video
            ref={video}
            src={url}
            controls
            preload="metadata"
            onTimeUpdate={(e) =>
              setPosition(e.currentTarget.currentTime * 1000)
            }
            onError={() =>
              setError("无法预览此视频编码，仍可处理字幕或导出为 MP4。")
            }
          />
          {active && (
            <div className="subtitle-overlay">
              <div>{active.text}</div>
              <div>{active.translation}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="preview-placeholder">
          <Icon name="film" size={36} />
          <b>画面即将在这里呈现</b>
          <span>在线视频下载后即可预览</span>
        </div>
      )}
      <div className="preview-hint">
        点击字幕编号定位视频 · 预览使用当前编辑内容，导出使用已保存版本
      </div>
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
