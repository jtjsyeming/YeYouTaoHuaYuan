// 夜游桃花源 · 爱情计时器可见性桥（D-08）
// 设计要点见《24-修复文档-H003-LoveTime后台标签暂停推送-v2.0.md》§2.1
//
// 只读 document.visibilityState，绝不改读 document.hidden：
//   e2e（d08_visibility.spec.mjs）用 Object.defineProperty 在 document 实例上遮蔽
//   visibilityState 来造后台，该手法不会同步改写 hidden —— 读 hidden 会让用例假绿。
//
// 与 gamekeyboard.js 同机制：IJSObjectReference 按需 import，不挂 window 全局。
let currentId = 0;
let seq = 0;
let handler = null;
let pageHideHandler = null;

/**
 * 注册 visibilitychange 监听，返回**可序列化**句柄（int）。
 * 函数本身不能回传给 .NET（不可 JSON 序列化，会得到 undefined 从而永远注销不掉），
 * 所以句柄是自增 id，真正的 handler 存在模块作用域里。
 * @param {DotNetObjectReference} ref 组件引用，需提供 [JSInvokable] OnVisibilityChanged(string)
 * @returns {number} 注册 id，Dispose 时原样传给 unregister
 */
export function register(ref) {
  removeListener(); // 幂等：先拆旧监听（含上一页遗留）

  handler = () => {
    // catch：断线 / 组件已销毁时 Promise 会被 reject，不接住会污染控制台（NF-06）
    ref.invokeMethodAsync('OnVisibilityChanged', document.visibilityState).catch(() => {});
  };

  document.addEventListener('visibilitychange', handler);

  // 整篇卸载（F5 / 地址栏换址 / 站外链接）时的真实派发顺序（Firefox 实测）：
  //   beforeunload → 【Circuit 断开】→ pagehide → visibilitychange(hidden) → unload
  // 那个 hidden 不是"用户切走了标签"，而是页面正在销毁；此时电路已断，
  // handler 里那次 invokeMethodAsync 会让 blazor.server.js 在控制台打出
  // "Cannot send data if the connection is not in the 'Connected' State."（NF-06 红）。
  // pagehide 早于 visibilitychange，在这里同步摘监听即可 —— 纯 JS，不发任何 interop。
  pageHideHandler = () => removeListener();
  window.addEventListener('pagehide', pageHideHandler);

  // 注册即同步一次当前态（P-026 / FT-30）：「页面初始就在后台」不存在任何 visibilitychange 可依赖，
  // 只靠事件会让后台打开的标签页一直按可见态推送。这是"注册那一刻读一次"，不是事件，与上面的
  // pagehide 清理互不干扰；invoke 同样挂 catch（断线/已销毁时不能污染控制台）。
  ref.invokeMethodAsync('OnVisibilityChanged', document.visibilityState).catch(() => {});

  currentId = ++seq;
  return currentId;
}

/**
 * 仅在 id 仍是当前注册时拆除。
 * 跨页导航时"新页 register"与"旧页 unregister"的先后顺序没有保证，
 * 若旧页后执行 unregister 而无条件拆监听，会把新页刚装上的监听删掉。
 */
export function unregister(id) {
  if (id !== currentId) return;
  removeListener();
  currentId = 0;
}

function removeListener() {
  if (handler) document.removeEventListener('visibilitychange', handler);
  handler = null;
  if (pageHideHandler) window.removeEventListener('pagehide', pageHideHandler);
  pageHideHandler = null;
}
