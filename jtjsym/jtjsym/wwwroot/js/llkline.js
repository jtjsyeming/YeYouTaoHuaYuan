// H-015 连连看连接线（《39》§5）。
// 一次 drawPath 画一层 SVG；新调用立刻 cancel 旧动画并移除旧节点（代际号 seq）。
// e2e 的三个固定挂点：svg.llk-line-svg / polyline[data-llk-mode] / circle[data-llk-bend]。
//
// 三个必须记住的坑：
//   ① 坐标一律用「实测格差」算 pitch，不写 cell + 6 —— 紧凑档（320）gap 是 4，写死会把线画歪。
//      ⚠ D-38 起连 pitch 也不需要了：坐标改为**逐格实测**，见 ③。
//   ② 外圈点要钳到盘边的 EDGE = 1px，不是 cell/2：320 档 c = -1 的 x 是 -25，
//      钳到 cell/2 (=21) 会正好落在第 0 列中心，线穿进格子里，"从外面绕"的语义就没了。
//   ③ **不要**再用参照格反推坐标系（D-38）。旧版拿 idx 0/1/6 当固定参照，
//      而 face==0 的格永久带着 .is-gone 的 transform: scale(.6)，getBoundingClientRect()
//      返回缩小 40% 的矩形 —— 参照格被消掉后整条线按 0.2 格/步推歪（桌面档最坏 82.6px）。
//      正解是逐轴读一格：同一列所有格中心横坐标相同、同一行所有格中心纵坐标相同，
//      而 scale 以格中心为原点 ⇒ 中心在任何缩放中间态都不动。

const SVG_NS = 'http://www.w3.org/2000/svg';
const STROKE = '#B3423C';
const WIDTH = 2;
const EDGE = WIDTH / 2;      // 线宽一半：钳到这个值，整条线正好落在盘内
const DASH = 6;              // 一个 dash 周期 = 6 + 6；流动位移必须等于 2 * DASH
const HINT_LIFE = 1600;      // 与页面 ShowFeedbackAsync 的 FeedbackMs 同生同灭
const SUCCESS_DRAW = 340;    // 描线时长，也是 .llk-cell.is-gone 的 transition-delay
const SUCCESS_HOLD = 160;
const FADE = 200;
const ROWS = 8;              // 镜像 LianliankanCore.Rows/Cols（JS 读不到 C# 常量，两处必须同时改）
const COLS = 6;

let seq = 0;
let host = null;
let timer = null;

function removeSvg() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (host && host.parentNode) host.parentNode.removeChild(host);
  host = null;
}

const reducedMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/**
 * 画一条连接线。
 * @param {string} boardSelector  棋盘容器（必须是 position: relative，SVG 以它为原点）
 * @param {number[][]} points     [[r, c], …]，来自 Core 的 LlkPath.Points（盘外点是负数/越界值）
 * @param {'success'|'hint'} mode 实线描线 / 虚线流动 + 拐点呼吸
 */
export function drawPath(boardSelector, points, mode) {
  const board = document.querySelector(boardSelector);
  if (!board || !Array.isArray(points) || points.length < 2) return;

  const my = ++seq;
  removeSvg();

  const boardRect = board.getBoundingClientRect();
  if (boardRect.width <= 0) return;
  const boardW = boardRect.width;
  const boardH = boardRect.height;

  // D-38：坐标**逐格实测**，不再用 cell / pitch 反推。
  //   已消除格带 .is-gone 的 transform: scale(.6)，getBoundingClientRect() 会缩到 60%：
  //   拿 idx 0/1/6 当固定参照时，缩过的格会把整条线按 0.2 格/步推歪（桌面档最坏 82.6px）。
  //   只依赖「同一列/同一行的格中心对齐」这条 grid 事实 —— 中心在任何缩放中间态都不动。
  const centerOf = idx => {
    const el = board.querySelector(`[data-idx="${idx}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return null;
    return [r.left - boardRect.left + r.width / 2, r.top - boardRect.top + r.height / 2];
  };
  const colX = c => centerOf(c)?.[0];            // 第 0 行第 c 格
  const rowY = r => centerOf(r * COLS)?.[1];     // 第 r 行第 0 格

  const clamp = (v, hi) => Math.min(Math.max(v, EDGE), hi - EDGE);

  const pts = [];
  for (const p of points) {
    const r = p[0], c = p[1];
    const x = c >= 0 && c < COLS ? colX(c) : (c < 0 ? EDGE : boardW - EDGE);
    const y = r >= 0 && r < ROWS ? rowY(r) : (r < 0 ? EDGE : boardH - EDGE);
    if (x === undefined || y === undefined) return;   // 防御：格子拿不到就不画，别抛错
    pts.push([Math.round(clamp(x, boardW)), Math.round(clamp(y, boardH))]);
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'llk-line-svg');
  svg.setAttribute('width', String(Math.round(boardW)));
  svg.setAttribute('height', String(Math.round(boardH)));
  svg.setAttribute('viewBox', `0 0 ${Math.round(boardW)} ${Math.round(boardH)}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  // overflow: visible 不是为了外圈（已经钳进来），是为了拐点圆：圆心在 EDGE 时 r=4 会溢出 3px
  svg.style.overflow = 'visible';
  svg.style.pointerEvents = 'none';

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', pts.map(p => `${p[0]},${p[1]}`).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', STROKE);
  line.setAttribute('stroke-width', String(WIDTH));
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('data-llk-mode', mode);
  svg.appendChild(line);

  const isHint = mode === 'hint';
  if (isHint) {
    // 虚线：与"成了"的实线一眼可分。dasharray 被虚线占用 ⇒ 不能再靠 dashoffset 做"描线生长"
    line.setAttribute('stroke-dasharray', `${DASH} ${DASH}`);

    // 拐点：只画中间点（两端是格子本身）
    for (let i = 1; i < pts.length - 1; i++) {
      const bend = document.createElementNS(SVG_NS, 'circle');
      bend.setAttribute('cx', String(pts[i][0]));
      bend.setAttribute('cy', String(pts[i][1]));
      bend.setAttribute('r', '4');
      bend.setAttribute('fill', STROKE);
      bend.setAttribute('data-llk-bend', '1');
      svg.appendChild(bend);
    }
  }

  board.appendChild(svg);
  host = svg;

  if (isHint) {
    if (!reducedMotion()) {
      line.animate([{ opacity: '0' }, { opacity: '1' }],
        { duration: 140, easing: 'ease-out', fill: 'forwards' });
      // 呼吸 = 虚线朝终点方向持续流动（一个周期 12px / 600ms）
      line.animate(
        [{ strokeDashoffset: '0px' }, { strokeDashoffset: `${-2 * DASH}px` }],
        { duration: 600, iterations: Infinity, easing: 'linear' });
      svg.querySelectorAll('circle[data-llk-bend]').forEach(b => {
        b.animate([{ opacity: '1' }, { opacity: '0.35' }, { opacity: '1' }],
          { duration: 600, iterations: 2, easing: 'ease-in-out' });
      });
    }
    timer = setTimeout(() => {
      if (my !== seq) return;
      removeSvg();
    }, HINT_LIFE);
    return;
  }

  // success：实线 + 描线生长（dasharray = 总长 ⇒ 视觉上就是实线在从起点长出）
  if (reducedMotion()) {
    timer = setTimeout(() => {
      if (my !== seq) return;
      removeSvg();
    }, 150 + FADE);
    return;
  }

  const len = line.getTotalLength();
  line.style.strokeDasharray = `${len}`;
  line.animate([{ strokeDashoffset: `${len}px` }, { strokeDashoffset: '0px' }],
    { duration: SUCCESS_DRAW, easing: 'ease-out', fill: 'forwards' });

  setTimeout(() => {
    if (my !== seq) return;
    svg.animate([{ opacity: '1' }, { opacity: '0' }], { duration: FADE, fill: 'forwards' });
  }, SUCCESS_DRAW + SUCCESS_HOLD);

  timer = setTimeout(() => {
    if (my !== seq) return;
    removeSvg();
  }, SUCCESS_DRAW + SUCCESS_HOLD + FADE + 40);
}

/** ④ 层清场：彻底没路时把还在飘的旧虚线一起收掉。 */
export function clear() {
  seq++;
  removeSvg();
}
