/**
 * js/render-throttle.js — 渲染节流:只渲染最新一帧,丢弃中间帧。
 *
 * 当解码/转换速度快于屏幕刷新时,主线程渲染会积压,导致网页操作
 * (点击/按键)延迟升高。本工具保证每帧只渲染一次、只渲染最新帧,
 * 让浏览器事件循环始终有机会处理用户操作。
 *
 * 用法:
 *   const render = createLatestFrameRenderer((frame) => { ...绘制... }, { closeFrame });
 *   render(frame); // 可高频调用,内部只保留最新一帧
 */
export function createLatestFrameRenderer(renderFn, { closeFrame, onDrop } = {}) {
  let latest = null;
  let scheduled = false;
  return (frame) => {
    if (latest !== null) {
      // 被替换的旧帧尚未渲染即被丢弃,计入丢帧统计
      if (onDrop) {
        try {
          onDrop();
        } catch {}
      }
      if (closeFrame) {
        // 释放被替换的旧帧(如 VideoFrame 需 close 释放资源)
        try {
          closeFrame(latest);
        } catch {}
      }
    }
    latest = frame;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const f = latest;
      latest = null;
      if (f !== null) {
        try {
          renderFn(f);
        } catch {
          // 渲染失败不影响主流程
        }
      }
    });
  };
}
