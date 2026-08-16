/**
 * js/hotkeys.js — 全局快捷键(MOD = Ctrl+Shift,macOS 为 Cmd+Shift)。
 *
 * 以捕获阶段监听,命中后 preventDefault,避免把 UI 快捷键转发给设备。
 */
import {
  encodeRotateDevice,
  encodeInjectKeycode,
  encodeBackOrScreenOn,
  encodeExpandNotificationPanel,
  encodeExpandSettingsPanel,
  encodeCollapsePanels,
  encodeSetDisplayPower,
  KeyEventAction,
  KeyCode,
} from "../../shared/protocol.js";

export const HOTKEYS = [
  ["MOD + i", "显示/隐藏统计面板(帧率、传输速率、延迟)"],
  ["MOD + h", "显示/隐藏快捷键帮助"],
  ["MOD + f", "全屏切换"],
  ["MOD + r", "设备旋转 90°"],
  ["MOD + s", "截图(保存 PNG)"],
  ["MOD + b", "设备返回键"],
  ["MOD + Home", "设备 Home 键"],
  ["MOD + End", "设备最近任务"],
  ["MOD + u", "设备屏幕开关"],
  ["MOD + n / e / c", "通知栏 / 快捷设置 / 收起面板"],
  ["MOD + 1~4", "切换码率档位(1/2/4/8 Mbps)"],
  ["MOD + 0", "聚焦自定义码率输入框"],
  ["MOD + ↑ / ↓", "音量 + / -"],
  ["Esc", "关闭面板 / 退出全屏"],
];

export function setupHotkeys(handlers) {
  /**
   * handlers: {
   *   toggleStats, toggleHelp, toggleFullscreen, rotateDevice,
   *   screenshot, deviceBack, deviceHome, deviceAppSwitch,
   *   toggleScreenPower, toggleNotification, toggleSettings, collapsePanels,
   *   setBitratePreset(index), focusCustomBitrate, volumeUp, volumeDown
   * }
   */
  const isMod = (e) => (e.ctrlKey && e.shiftKey) || (e.metaKey && e.shiftKey);

  document.addEventListener(
    "keydown",
    (e) => {
      // 焦点在输入控件时不拦截
      const tag = (e.target && e.target.tagName) || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;

      const mod = isMod(e);
      const key = e.key;

      if (mod) {
        switch (key) {
          case "i": case "I": return consume(e, handlers.toggleStats);
          case "h": case "H": return consume(e, handlers.toggleHelp);
          case "f": case "F": return consume(e, handlers.toggleFullscreen);
          case "r": case "R": return consume(e, handlers.rotateDevice);
          case "s": case "S": return consume(e, handlers.screenshot);
          case "b": case "B": return consume(e, handlers.deviceBack);
          case "u": case "U": return consume(e, handlers.toggleScreenPower);
          case "n": case "N": return consume(e, handlers.toggleNotification);
          case "e": case "E": return consume(e, handlers.toggleSettings);
          case "c": case "C": return consume(e, handlers.collapsePanels);
          case "0": return consume(e, handlers.focusCustomBitrate);
          case "1": case "2": case "3": case "4": case "5":
            return consume(e, () => handlers.setBitratePreset(Number(key) - 1));
          case "ArrowUp": return consume(e, handlers.volumeUp);
          case "ArrowDown": return consume(e, handlers.volumeDown);
          case "Home": return consume(e, handlers.deviceHome);
          case "End": return consume(e, handlers.deviceAppSwitch);
          case "Backspace": return consume(e, handlers.deviceBack);
          default: break;
        }
        return;
      }

      // 非 MOD 组合:Esc 关闭面板/退出全屏
      if (key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        handlers.onEscape && handlers.onEscape();
      }
    },
    { capture: true }
  );
}

function consume(e, fn) {
  e.preventDefault();
  e.stopPropagation();
  if (fn) fn();
}

/** 便捷封装:把设备按键消息发送函数打包成 handlers */
export function deviceKeyHandlers(sendControl) {
  // 按键事件必须发送 DOWN+UP 完整事件对,设备端才会响应(Home/最近任务/音量等)
  const press = (keycode) => {
    sendControl(encodeInjectKeycode(KeyEventAction.DOWN, keycode, 0, 0));
    sendControl(encodeInjectKeycode(KeyEventAction.UP, keycode, 0, 0));
  };
  return {
    deviceBack: () => sendControl(encodeBackOrScreenOn(KeyEventAction.DOWN)),
    deviceHome: () => press(KeyCode.HOME),
    deviceAppSwitch: () => press(KeyCode.APP_SWITCH),
    toggleScreenPower: () => sendControl(encodeSetDisplayPower(false)),
    toggleNotification: () => sendControl(encodeExpandNotificationPanel()),
    toggleSettings: () => sendControl(encodeExpandSettingsPanel()),
    collapsePanels: () => sendControl(encodeCollapsePanels()),
    rotateDevice: () => sendControl(encodeRotateDevice()),
    volumeUp: () => press(KeyCode.VOLUME_UP),
    volumeDown: () => press(KeyCode.VOLUME_DOWN),
  };
}
