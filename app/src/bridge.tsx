import type { DesktopApi } from "@dobstudio/core/studio";
declare global {
  interface Window {
    dobstudio: DesktopApi;
  }
}
export const api = window.dobstudio;
export type Act = <T>(fn: () => Promise<T>) => Promise<T | undefined>;
export function Empty() {
  return <div className="empty">先从项目库选择或导入一个视频。</div>;
}
