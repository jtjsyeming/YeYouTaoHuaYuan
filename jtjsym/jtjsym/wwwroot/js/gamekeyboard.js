// 夜游桃花源 游戏键盘支持（Game_2048 / Tetris 共用）
// 设计要点见《10-开发文档-D02键盘操作与2048视觉统一-v2.0.md》§3.2
//
// 为什么用 window 级监听而不是 Blazor 的 @onkeydown：
//   1) 元素级事件在焦点离开游戏区后失效，且 @onkeydown 拿不到 window 级 keyup；
//   2) Tetris 的软降必须有 keyup（松手停），元素级方案覆盖不到"点过按钮再按住键盘"；
//   3) 需要按键级 preventDefault（只拦四个方向键），元素级只能整元素全拦。
const MOVE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const REPEAT_MIN_INTERVAL_MS = 60; // 连发节流：浏览器 autorepeat ~30Hz，一次按键 = 一次 SignalR 往返

let cfg = { repeatKeys: [] }; // 允许连发的键（2048 传空数组 = 全部忽略连发）
let currentId = 0;
let seq = 0;
let activeRef = null;
let keydownHandler = null;
let keyupHandler = null;
let unloading = false; // 页面正在卸载（导航离开 / 关页）
let lastInvokeAt = Object.create(null);

// 释放软降的延迟：导航期间 blur / visibilitychange 会先于卸载触发，
// 而那一刻 SignalR 连接可能已经断开，直接 invoke 会让 blazor.server.js 打出
// "Cannot send data if the connection is not in the 'Connected' State."（Firefox 实测必现）。
// 推迟一小段时间 + 用 pagehide 标记短路，既保住"切窗口即释放"，又不污染控制台（NF-06）。
const RELEASE_DELAY_MS = 150;

/**
 * 注册键盘监听，返回注册 id；调用方保存它，Dispose 时传给 unregister。
 * @param {DotNetObjectReference} ref 组件引用，需提供 OnKeyDown/OnKeyUp
 * @param {{repeatKeys?: string[]}} [options] 允许按住连发的键
 */
export function register(ref, options = {}) {
  removeListeners(); // 幂等：先拆旧监听（含上一页遗留）
  cfg = { repeatKeys: options.repeatKeys ?? [] };
  lastInvokeAt = Object.create(null);
  activeRef = ref;

  keydownHandler = (e) => {
    if (!MOVE_KEYS.includes(e.key)) return;
    // 将来页面若加输入框，避免打字时游戏乱动
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;

    e.preventDefault(); // 只拦方向键，F5/Tab/Ctrl 组合零干扰

    if (e.repeat) {
      if (!cfg.repeatKeys.includes(e.key)) return; // 2048 与 ↑/↓：连发无意义，忽略
      const now = performance.now();
      if (now - (lastInvokeAt[e.key] ?? 0) < REPEAT_MIN_INTERVAL_MS) return;
      lastInvokeAt[e.key] = now;
    }
    // catch：断线/组件已销毁时 Promise 会被 reject，不接住会污染控制台（NF-06）
    ref.invokeMethodAsync('OnKeyDown', e.key).catch(() => {});
  };

  keyupHandler = (e) => {
    if (!MOVE_KEYS.includes(e.key)) return;
    ref.invokeMethodAsync('OnKeyUp', e.key).catch(() => {});
  };

  window.addEventListener('keydown', keydownHandler);
  window.addEventListener('keyup', keyupHandler);
  // keyup 在窗口失焦 / 切标签页时收不到（事件发给新窗口），Tetris 会一直软降直到下次按键
  window.addEventListener('blur', requestRelease);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  currentId = ++seq;
  // 键盘就绪信号（P-039）：E2E 不能靠"固定等 1500ms"来猜监听是否已装上 ——
  // 慢机 / CI 上 register 晚到就会让按键落空（FT-22 实测 8 PASS / 1 FAIL）。
  // 用 window 上的布尔量做 waitForFunction 的判据；unregister / removeListeners 都会置回 false。
  window.__jtjsymKbdReady = true;
  return currentId;
}

/**
 * 仅在 id 仍是当前注册时拆除。
 * 跨页导航时"新页 register"与"旧页 unregister"的先后顺序没有保证，
 * 若旧页后执行 unregister 而无条件拆监听，会把新页刚装上的监听删掉。
 */
export function unregister(id) {
  if (id !== currentId) return;
  removeListeners();
  currentId = 0;
  activeRef = null;
}

/** 释放所有按键（当前实现只关心 ↓ 软降）：防止"按住 ↓ 切走窗口"导致软降卡死 */
export function releaseAll(ref) {
  const target = ref ?? activeRef;
  if (target) target.invokeMethodAsync('OnKeyUp', 'ArrowDown').catch(() => {});
}

function onPageHide() {
  unloading = true;
}

function onVisibilityChange() {
  if (document.hidden) requestRelease();
}

/** 延迟释放：等一小段时间，若页面其实正在卸载（pagehide 已置位）就放弃，避免断线后发消息 */
function requestRelease() {
  setTimeout(() => {
    if (unloading) return;
    releaseAll();
  }, RELEASE_DELAY_MS);
}

function removeListeners() {
  if (keydownHandler) window.removeEventListener('keydown', keydownHandler);
  if (keyupHandler) window.removeEventListener('keyup', keyupHandler);
  window.removeEventListener('blur', requestRelease);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', onPageHide);
  keydownHandler = keyupHandler = null;
  window.__jtjsymKbdReady = false;   // 撤掉监听 = 不再就绪（P-039）；register 会重新置 true
}
