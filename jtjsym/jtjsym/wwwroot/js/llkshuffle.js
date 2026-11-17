// H-017 重排「打乱重排」：FLIP 滑入。
// 只动 transform，**不碰 opacity** —— 淡入由 CSS 的 .is-shuffle-in 负责。
// 两者分开是有原因的：script 动画在合成顺序上压过 CSS animation，
// 这里也写 opacity 会把 .is-shuffle-in 整段覆盖（实测 CSS 0.5 / WAAPI 0.25 ⇒ 读到 0.25）。
//
// ⚠ 三处 e2e 依赖：is-shuffle-fly 的存活区间（LL-31 数它）、动画对象是 script 类型
//   （不是 CSSTransition）、首个 keyframe 的 translate 值（LL-31 拿它核对位移与交换）。
//   改这三样的任一形态，先去看 lianliankan.spec.mjs 的 LL-31。

const FLIP_MS = 380;      // 必须与页面 ShuffleFlipMs 一致

const reducedMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * @param {string} boardSelector 棋盘容器（position: relative，格子是它的子节点）
 * @param {number[][]} moves     [[fromIdx, toIdx], …]，来自 LianliankanCore.PairShuffleMoves
 * @returns {number} 真正播了动画的方块数（0 = 没有位移 / reduced-motion）
 */
export function playShuffle(boardSelector, moves) {
  const board = document.querySelector(boardSelector);
  if (!board || !Array.isArray(moves) || moves.length === 0) return 0;
  if (reducedMotion()) return 0;      // 页面侧已短路，这里双保险

  const cellOf = i => board.querySelector(`[data-idx="${i}"]`);
  const center = el => {
    const r = el.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };

  // ⚠ 必须**先把所有位移量量完，再统一起播**。一次互换就是 moves = [[6,0],[0,6]] 这种
  //   互为 from/to 的对；若边量边播，第二段的 center(from) 读到的是**第一段已经位移过**的 rect
  //   （WAAPI 起播即刻生效）⇒ dy 恰好抵消成 0 ⇒ 命中 dx===0 && dy===0 被跳过 ⇒
  //   两个方块只有一个在飞。实测踩过，LL-31 就是靠"恰好 2 格"抓到的。
  //   这不是风格问题，是 FLIP 的「First 全量采样 → Play」次序。
  const jobs = [];
  for (const m of moves) {
    const from = cellOf(m[0]);
    const to = cellOf(m[1]);
    if (!from || !to) continue;

    const a = center(from);
    const b = center(to);
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    if (dx === 0 && dy === 0) continue;      // 没动（同脸滞留原格已在 C# 侧被排除，这里是双保险）

    jobs.push({ to, dx, dy });
  }

  let played = 0;
  for (const { to, dx, dy } of jobs) {
    // 飞行期间必须压在别的格上面：同层绘制按 DOM 先后，往"索引更大"的方向飞会被目标格吃掉一段。
    // 这个 class 由 onfinish/oncancel 摘掉，与组件状态无关（别改成内联 style，见 §3.6 的注释）。
    to.classList.add('is-shuffle-fly');

    const anim = to.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: FLIP_MS, easing: 'ease-out' });

    const done = () => to.classList.remove('is-shuffle-fly');
    anim.onfinish = done;
    anim.oncancel = done;
    played++;
  }
  return played;
}
