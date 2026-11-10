// 夜游桃花源 俄罗斯方块 · 页面隐藏即暂停（《33》D-24a）
// 设计要点：切后台期间服务端 timer 照跑（1 秒一拍的方落 + 180 秒一拍的升级），
//   只做"回前台恢复快照"挡不住它 —— 后台玩到结束，快照已被结束态清掉。
//   故在 hidden 的第一时间通知服务端 PauseGame()，让"回来"永远是暂停待继续。
//
// 与 lovetimer.js（D-08/H-003）同手法、反方向：那边是"后台停推送"，这边是"后台停游戏"。
// 只监听 hidden、不监听 visible：回前台由用户按「继续游戏」，不自动续跑。
//
// 模块级单例 + 幂等 register：import 是 ES 模块缓存，同一路径拿到的永远是同一份模块实例，
// 两个 Tetris 实例（理论上不会同时存在）以后注册的为准 —— 与 gamekeyboard.js 的 currentId 抢占同语义。

// 通知的延迟：导航离开时**先于卸载**会来一发 visibilitychange(hidden)，
// 那一刻 SignalR 连接可能已经断开，直接 invoke 会让 blazor.server.js 打出
// "Cannot send data if the connection is not in the 'Connected' State."（Firefox 实测必现）。
// 与 gamekeyboard.js 的 RELEASE_DELAY_MS 同一手法：推迟一小段时间 + 用 pagehide 标记短路，
// 既保住"切后台即暂停"（150ms 无感），又不污染控制台（NF-01/NF-06 都断言零红）。
const NOTIFY_DELAY_MS = 150;

let handler = null;
let timer = null;
let unloading = false;

const onPageHide = () => {
  unloading = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
};

export function registerVisibility(dotnetRef) {
  unregisterVisibility();

  unloading = false;
  window.addEventListener('pagehide', onPageHide);

  handler = () => {
    if (document.visibilityState !== 'hidden') return;
    if (unloading) return;
    if (timer !== null) clearTimeout(timer);

    timer = setTimeout(() => {
      timer = null;
      if (unloading) return;
      // 通知是尽力而为：circuit 已死时 invoke 会 reject，不能让它冒泡成 pageerror
      try {
        const p = dotnetRef.invokeMethodAsync('OnPageHidden');
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* 连接已断：忽略 */
      }
    }, NOTIFY_DELAY_MS);
  };

  document.addEventListener('visibilitychange', handler);
}

export function unregisterVisibility() {
  if (handler) {
    document.removeEventListener('visibilitychange', handler);
    handler = null;
  }
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  window.removeEventListener('pagehide', onPageHide);
  unloading = false;
}
