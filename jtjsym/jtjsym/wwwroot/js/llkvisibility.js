// 夜游桃花源 连连看切后台暂停（《36》v2.0 §3.4）
//
// 为什么另写一个模块而不是复用 gamekeyboard.js：
//   gamekeyboard 的 register 会接管四个方向键并把 keydown 全拦下来，而连连看没有键盘操作 ——
//   复用它等于给一个纯点击的游戏装上"方向键被吃掉"的副作用。
//   但 interop 的注册 / 注销 / dotNetRef 释放这套形状照抄（D-24 已验证可用），只保留 visibility 那一条。
//
// 为什么必须暂停：计时器在服务端跑，标签页隐藏时照走 —— 切后台 5 分钟回来"用时"直接 +300 秒，
// 竞速成绩当场报废。v1.0 曾写"不做后台暂停"，那条对连连看不成立。
let ref = null;
let handler = null;
let currentId = 0;
let seq = 0;
let unloading = false;   // 页面正在卸载（导航离开 / 关页）

// 延迟一拍再 invoke：导航期间 visibilitychange 会先于卸载触发，
// 而那一刻 SignalR 可能已经断开，直接 invoke 会让 blazor.server.js 打出
// "Cannot send data if the connection is not in the 'Connected' State."（污染 NF-06）
const RELEASE_DELAY_MS = 150;

/**
 * 注册可见性监听，返回注册 id；调用方保存它，Dispose 时传给 unregister。
 * @param {DotNetObjectReference} dotNetRef 组件引用，需提供 PauseTimer()
 */
export function register(dotNetRef) {
  remove();               // 幂等：先拆旧监听（含上一页遗留）
  ref = dotNetRef;
  unloading = false;

  handler = () => {
    if (!document.hidden) return;
    window.setTimeout(() => {
      if (unloading || !ref) return;
      ref.invokeMethodAsync('PauseTimer').catch(() => {});
    }, RELEASE_DELAY_MS);
  };

  document.addEventListener('visibilitychange', handler);
  window.addEventListener('pagehide', onPageHide);

  currentId = ++seq;
  // 就绪信号：e2e 不该靠"固定等 X ms"来猜监听装好没有（P-039 的教训）
  window.__jtjsymLlkVisReady = true;
  return currentId;
}

/**
 * 用户是否偏好减少动效（D-31）。
 * 放在这里而不是走 `eval`：`matchMedia` 返回 MediaQueryList 对象，IJSRuntime 序列化不成 bool，
 * 而 `eval` 在严格 CSP 下会被拦（且不该为一个布尔值开这个口子）。反正本模块本来就要加载。
 */
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 仅在 id 仍是当前注册时拆除（跨页导航时新旧页的先后顺序没有保证）。 */
export function unregister(id) {
  if (id !== undefined && id !== currentId) return;
  remove();
  currentId = 0;
  ref = null;
}

function onPageHide() {
  unloading = true;
}

function remove() {
  if (handler) document.removeEventListener('visibilitychange', handler);
  window.removeEventListener('pagehide', onPageHide);
  handler = null;
  window.__jtjsymLlkVisReady = false;
}
