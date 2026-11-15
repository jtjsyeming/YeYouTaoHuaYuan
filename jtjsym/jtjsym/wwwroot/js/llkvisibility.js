// 夜游桃花源 连连看切后台暂停（《36》v2.0 §3.4）+ sprite 可用性探测（H-016 / D-33）
//
// 为什么另写一个模块而不是复用 gamekeyboard.js：
//   gamekeyboard 的 register 会接管四个方向键并把 keydown 全拦下来，而连连看没有键盘操作 ——
//   复用它等于给一个纯点击的游戏装上"方向键被吃掉"的副作用。
//   但 interop 的注册 / 注销 / dotNetRef 释放这套形状照抄（D-24 已验证可用），只保留 visibility 那一条。
//
// 为什么 H-016 的探测也放这里：本模块**已经在 firstRender 加载**、也已经在 DisposeAsync 释放；
//   而 llkline.js 是"首次画线"才按需加载的 —— 把探测塞进去等于每次进页面都拉一遍连接线模块。
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

// ───────────────── sprite 可用性探测（H-016 / D-33） ─────────────────

/**
 * 探测 sprite 到底能不能被画出来，并按结果切降级态。
 *
 * 为什么必须借 JS：`background-image` 加载失败是**静默**的 —— CSS 侧拿不到"失败"这个状态，
 * `getComputedStyle().backgroundImage` 在 404 / 被拦 / 无图模式下**照样返回那条 url**，
 * 页面只会回落到 background-color（48 格纯平色块，看着像"格子还没加载完"）。
 *
 * 为什么对外只有一个函数：IJSRuntime 传不了 JS 回调，所以"迟到恢复"必须在 JS 内部自销 ——
 * 否则 C# 侧只能拿到一个 boolean，等图真到了还得再 interop 一次，而那时已经不知道该不该恢复。
 *
 * 副作用范围：只动 DOM（class + data-llk-sprite），**不进 Blazor 渲染状态**。
 * `.llk-board` 的 class 在渲染树里是常量，每次 diff 都不含它 ⇒ Blazor 不会把 JS 加的类抹掉。
 *
 * @param {string} selector   棋盘容器，如 '.llk-board'
 * @param {string} url        sprite 地址
 * @param {number} timeoutMs  首次判定上限。超时先给结论，但**继续等**（弱网"先字后图"）
 * @returns {Promise<'ok'|'fallback'|'absent'>}
 */
export async function applySpriteFallback(selector, url, timeoutMs) {
  const board = document.querySelector(selector);
  if (!board) return 'absent';

  board.dataset.llkSprite = 'pending';
  const ok = await probeSprite(url, timeoutMs, () => {
    // 超时之后图才到 —— 撤销降级，避免弱网用户永远停在字牌
    board.classList.remove('llk-no-sprite');
    board.dataset.llkSprite = 'ok';
  });

  if (ok) {
    board.dataset.llkSprite = 'ok';
    return 'ok';
  }
  board.classList.add('llk-no-sprite');
  board.dataset.llkSprite = 'fallback';
  return 'fallback';
}

/**
 * 内部：首次结论由 promise 给，迟到加载走 onLateOk。
 * @param {(ok: boolean) => void} onLateOk 首次结论已给出且为 false 后，图又到了
 */
function probeSprite(url, timeoutMs, onLateOk) {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    img.onload = () => {
      // ⚠ 这一行是 v1.0 缺的那条：settled 之后直接 return 会让"迟到恢复"永远不发生
      //    （实测超时 300ms / 图 1200ms 到 ⇒ classAfter 恒 true，全量弱网用户永久停在字牌）
      if (settled) {
        if (img.naturalWidth > 0) onLateOk();
        return;
      }
      // 只问"有没有 decode 出东西"，**不写死 768×512**：
      // background-size 是百分比，换 @2x / 重切尺寸都能正确铺；写死像素等于给换图埋一颗"全量永久降级"的雷。
      settle(img.naturalWidth > 0);
    };
    img.onerror = () => settle(false);

    img.src = url;
    // 便宜之处：CSS 已经请求过同一 URL，这里命中内存缓存，**不产生第二个网络请求**（实测 cssRequests 恒 1）。
    setTimeout(() => settle(false), timeoutMs);
  });
}

function remove() {
  if (handler) document.removeEventListener('visibilitychange', handler);
  window.removeEventListener('pagehide', onPageHide);
  handler = null;
  window.__jtjsymLlkVisReady = false;
}
