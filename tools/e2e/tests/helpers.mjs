// 公共工具：等待、断言记录、俄罗斯方块/2048 的 DOM 读取
// 迁移自 2026-11-01 的临时场景脚本；选择器与校验算法保持不变，只替换外壳（期望值 → expect.soft）。
import { expect } from '@playwright/test';

export const EMPTY_COLOR = 'rgb(26, 26, 26)';

/** 七种方块颜色（TRIS-02） */
export const TETROMINO_COLORS = {
  'rgb(0, 255, 255)': 'I',
  'rgb(0, 0, 255)': 'J',
  'rgb(255, 165, 0)': 'L',
  'rgb(255, 255, 0)': 'O',
  'rgb(0, 255, 0)': 'S',
  'rgb(128, 0, 128)': 'T',
  'rgb(255, 0, 0)': 'Z',
};

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 用例断言。失败不中断本场景，最终汇总到同一个 test() 结果。
 * 约定：id 用《07》的用例编号，detail 写实测值，失败时可直接回溯用例。
 */
export function check(id, cond, detail) {
  expect.soft(!!cond, `[${id}] ${detail}`).toBe(true);
}

export function checkEq(id, actual, expected, detail = '') {
  // 用 toEqual：既支持标量，也支持对象/数组（D-11-2 的整表比对）
  expect
    .soft(actual, `[${id}] 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}${detail ? '；' + detail : ''}`)
    .toEqual(expected);
}

/** 收集浏览器侧异常；断言时用 errors.length */
export function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  return errors;
}

/**
 * 打开页面并等 Blazor Server 电路就绪。
 * 说明：Blazor Server 没有稳定的"就绪"信号，故沿用原脚本的 window.Blazor + 固定等待，
 * 不用 networkidle（SignalR 长连接会让它永远不 idle）。
 */
export async function open(page, path, settle = 1500) {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(settle);
}

export const boardUrl = '/game_2048';

// ───────────────────────────── 2048 ─────────────────────────────

export const readBoard = page =>
  page.$$eval('.game-container .row', rows =>
    rows.map(r => [...r.querySelectorAll('.tile')].map(t => parseInt(t.textContent.trim()) || 0)),
  );

export const readScore = async page => {
  // D-02 起页面文案由 "Score: N" 改为 "分数：N"；正则同时兼容两种写法，双保险
  const txt = await page.textContent('p:has-text("分数")');
  return parseInt(/(?:分数|Score)[:：]\s*(\d+)/.exec(txt)?.[1] ?? '-1');
};

export const countTiles = b => b.flat().filter(v => v !== 0).length;

export const clickDir = async (page, dir) => {
  const sel = { up: '⬆️', left: '⬅️', down: '⬇️', right: '➡️' }[dir];
  await page.locator(`.controls fluent-button:has-text("${sel}")`).click();
  await sleep(320);
};

/** 单行合并（标准 2048 语义：先压缩，再成对消费），与页面实现完全独立 */
export function moveLine(line) {
  const v = line.filter(x => x !== 0);
  const out = [];
  let i = 0,
    gain = 0;
  while (i < v.length) {
    if (i + 1 < v.length && v[i] === v[i + 1]) {
      out.push(v[i] * 2);
      gain += v[i] * 2;
      i += 2;
    } else {
      out.push(v[i]);
      i++;
    }
  }
  while (out.length < 4) out.push(0);
  return { out, gain };
}

export function simulate(board, dir) {
  const b = board.map(r => [...r]);
  let gain = 0;
  const apply = lines =>
    lines.map(l => {
      const r = moveLine(l);
      gain += r.gain;
      return r.out;
    });
  if (dir === 'left') return { board: apply(b), gain };
  if (dir === 'right')
    return { board: apply(b.map(r => [...r].reverse())).map(r => r.reverse()), gain };
  if (dir === 'up') {
    const cols = [0, 1, 2, 3].map(c => b.map(r => r[c]));
    const moved = apply(cols);
    return { board: b.map((r, i) => r.map((_, c) => moved[c][i])), gain };
  }
  const cols = [0, 1, 2, 3].map(c => b.map(r => r[c]).reverse());
  const moved = apply(cols);
  return { board: b.map((r, i) => r.map((_, c) => moved[c][3 - i])), gain };
}

// ─────────────────────────── 俄罗斯方块 ───────────────────────────

/**
 * 读取 tetris 页面状态。
 * 注意：08 起 overlay 的 top/left 是 calc(var(--cell-size) * n)，不再是可 parse 的像素，
 * 故改为读渲染后的实时几何，并按 canvas 边框宽度归一化回"网格坐标原点"。
 */
export const readTetris = page =>
  page.evaluate(() => {
    const cells = [...document.querySelectorAll('.grid-cell')].map(c => getComputedStyle(c).backgroundColor);
    const overlay = document.querySelector('.current-piece-overlay');
    const canvas = document.querySelector('.game-canvas');
    const firstCell = document.querySelector('.grid-cell');
    const info = [...document.querySelectorAll('.info-value')].map(e => e.textContent.trim());
    const pieceCells = [...document.querySelectorAll('.piece-cell')].map(c => getComputedStyle(c).backgroundColor);
    const rows = [...document.querySelectorAll('.piece-row')].map(r =>
      [...r.children].map(c => (c.className.includes('piece-cell') ? 1 : 0)),
    );
    const preview = [...document.querySelectorAll('.preview-cell')].map(c => getComputedStyle(c).backgroundColor);

    let overlayTop = null,
      overlayLeft = null,
      cellPx = null;
    if (canvas && firstCell) {
      const cr = canvas.getBoundingClientRect();
      const cs = getComputedStyle(canvas);
      const bx = parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const by = parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      const cw = firstCell.getBoundingClientRect().width;
      const ch = firstCell.getBoundingClientRect().height;
      cellPx = { w: cw, h: ch };
      if (overlay) {
        const r = overlay.getBoundingClientRect();
        overlayLeft = Math.round(r.left - cr.left - bx);
        overlayTop = Math.round(r.top - cr.top - by);
      }
    }

    return {
      cells,
      grid: Array.from({ length: 20 }, (_, r) => cells.slice(r * 10, r * 10 + 10)),
      overlayTop,
      overlayLeft,
      cellPx,
      pieceRows: rows,
      pieceColors: [...new Set(pieceCells.filter(c => c !== 'rgba(0, 0, 0, 0)'))],
      difficulty: info[0],
      score: info[1],
      previewFilled: preview.filter(c => c !== 'rgba(0, 0, 0, 0)').length,
      previewColors: [...new Set(preview.filter(c => c !== 'rgba(0, 0, 0, 0)'))],
      gameOver: !!document.querySelector('.game-over-text'),
      paused: !!document.querySelector('.continue-btn'),
      btns: [...document.querySelectorAll('.game-btn')].map(b => ({ t: b.textContent.trim(), dis: b.disabled })),
    };
  });

export const clickGameBtn = async (page, t, wait = 350) => {
  await page.locator(`.game-btn:has-text("${t}")`).click();
  await sleep(wait);
};

/** 按住软降按钮 ms 毫秒 */
export async function holdSoftDrop(page, ms) {
  const box = await page.locator('.down-btn').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(ms);
  await page.mouse.up();
}

/** 把方块移到目标列（校验到位，避免连点时 Blazor 丢事件） */
export async function moveToColumn(page, targetCol) {
  for (let i = 0; i < 12; i++) {
    const st = await readTetris(page);
    if (st.overlayLeft === null) return;
    const curCol = Math.round(st.overlayLeft / st.cellPx.w);
    if (curCol === targetCol) return;
    await page.locator(`.game-btn:has-text("${curCol < targetCol ? '→' : '←'}")`).click({ force: true });
    await sleep(70);
  }
}

const holeCount = grid => {
  let h = 0;
  for (let c = 0; c < 10; c++) {
    let seenBlock = false;
    for (let r = 0; r < 20; r++) {
      if (grid[r][c] !== EMPTY_COLOR) seenBlock = true;
      else if (seenBlock) h++;
    }
  }
  return h;
};

const columnHeights = grid => {
  const h = [];
  for (let c = 0; c < 10; c++) {
    let top = 20;
    for (let r = 0; r < 20; r++) {
      if (grid[r][c] !== EMPTY_COLOR) {
        top = r;
        break;
      }
    }
    h.push(20 - top);
  }
  return h;
};

/**
 * 形状若从 col 列落下，返回 { grid, row }：
 * grid = 落地后的棋盘；row = 方块**矩阵第 0 行**所在的行号（与 overlay 的 top 同一坐标系，供软降计分换算）。
 * 不可行返回 null。
 */
function landGrid(grid, shape, col) {
  const H = 20,
    W = 10;
  const cells = [];
  for (let r = 0; r < shape.length; r++)
    for (let c = 0; c < shape[r].length; c++) if (shape[r][c]) cells.push([r, c]);
  if (!cells.length) return null;

  let bestRow = null;
  for (let row = 0; row < H; row++) {
    let ok = true;
    for (const [r, c] of cells) {
      const gr = row + r,
        gc = col + c;
      if (gc < 0 || gc >= W || gr >= H) {
        ok = false;
        break;
      }
      if (grid[gr][gc] !== EMPTY_COLOR) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    bestRow = row;
  }
  if (bestRow === null) return null;

  const ng = grid.map(row => [...row]);
  for (const [r, c] of cells) ng[bestRow + r][col + c] = 'X';
  return { grid: ng, row: bestRow };
}

/** 评估落点：越少高度/洞/高低差、越多消行越好（Dellacherie 简化权重） */
function evaluateGrid(g, linesCleared) {
  const H = g.length,
    W = g[0].length;
  let agg = 0,
    holes = 0,
    bump = 0;
  const heights = [];
  for (let c = 0; c < W; c++) {
    let h = 0,
      seen = false;
    for (let r = 0; r < H; r++) {
      if (g[r][c] !== EMPTY_COLOR) {
        if (!seen) {
          seen = true;
          h = H - r;
        }
      } else if (seen) holes++;
    }
    heights.push(h);
    agg += h;
  }
  for (let c = 1; c < W; c++) bump += Math.abs(heights[c] - heights[c - 1]);
  return 100 * linesCleared - 0.5 * agg - 3 * holes - 0.2 * bump;
}

/** 消行模拟：删掉满行后在**顶部补等量空行**，行数恒为 20（与 Tetris.ClearRows 一致） */
const applyClear = g => {
  const kept = g.filter(row => row.some(v => v === EMPTY_COLOR));
  const cleared = g.length - kept.length;
  const empty = Array.from({ length: cleared }, () => Array(g[0].length).fill(EMPTY_COLOR));
  return { grid: empty.concat(kept), cleared };
};
const countFilled = g => g.flat().filter(v => v !== EMPTY_COLOR).length;
/** 只比"有块/没块"，颜色不参与（模拟棋盘用 'X' 占位） */
const mask = g => g.map(row => row.map(v => (v !== EMPTY_COLOR ? 1 : 0)).join(''));
const BONUS = { 1: 100, 2: 300, 3: 600, 4: 1000 };

/**
 * 有界自动玩（会玩的策略）：用于 TRIS-10~TRIS-13 的消行计分与消行后棋盘。
 * 策略：枚举当前方块的 4 种朝向 × 10 列，用启发式评分（消行数、聚合高度、洞数、高低差）选最优点，
 *      再"枚举实际形状 → 旋转到位 → 移到目标列 → 软降落地"，每步以 DOM 实际状态校验。
 *
 * 消行数不靠分数猜（软降每格 +1 会混进分数），而是用 空格数变化 精确反推：
 *      cleared = (落前非空格数 + 本次方块格数 − 落后非空格数) / 10
 * 分数再拆成 "软降分（下落行数） + 消行奖励" 逐次核对；棋盘与模拟结果逐格比对。
 */
export async function autoPlay(page, budgetMs = 180000) {
  const start = Date.now();
  let lastScore = 0;
  const events = [];
  let blocks = 0;
  let gameOver = false;

  while (Date.now() - start < budgetMs) {
    const st = await readTetris(page);
    if (st.gameOver) {
      gameOver = true;
      break;
    }

    // 1) 在中间列枚举朝向（贴墙旋转会被拒绝，故先回中间），记录**实际**形状
    await moveToColumn(page, 3);
    const shapes = [st.pieceRows.map(r => [...r])];
    for (let i = 0; i < 3; i++) {
      await page.locator('.game-btn:has-text("旋转")').click({ force: true });
      await sleep(90);
      shapes.push((await readTetris(page)).pieceRows.map(r => [...r]));
    }
    await page.locator('.game-btn:has-text("旋转")').click({ force: true }); // 转回初始朝向
    await sleep(90);

    // 2) 评分选优
    let bestScore = -Infinity;
    let best = null;
    for (let rot = 0; rot < shapes.length; rot++) {
      const cellsInShape = shapes[rot].flat().filter(v => v).length;
      if (!cellsInShape) continue;
      for (let col = 0; col < 10; col++) {
        const landed = landGrid(st.grid, shapes[rot], col);
        if (!landed) continue;
        const { grid: kept, cleared } = applyClear(landed.grid);
        const score = evaluateGrid(kept, cleared);
        if (score > bestScore) {
          bestScore = score;
          best = { rot, col, kept, cleared, cellsInShape, row: landed.row };
        }
      }
    }
    if (!best) {
      gameOver = true;
      break;
    }

    // 3) 执行：旋转到位 → 移到目标列
    if (best.rot > 0) {
      await moveToColumn(page, 3);
      for (let i = 0; i < best.rot; i++) {
        await page.locator('.game-btn:has-text("旋转")').click({ force: true });
        await sleep(90);
      }
    }
    await moveToColumn(page, best.col);

    // 落位校验：塔变高后，方块可能在移动途中就被锁定 → 这时的落点与模拟不同，不参与断言
    const mid = await readTetris(page);
    const actualCol = mid.overlayLeft === null ? null : Math.round(mid.overlayLeft / st.cellPx.w);
    const placed = actualCol === best.col && JSON.stringify(mask(mid.pieceRows)) === JSON.stringify(mask(shapes[best.rot]));

    await holdSoftDrop(page, 1100);
    blocks++;

    const st2 = await readTetris(page);
    const scoreAfter = parseInt(st2.score);
    const gain = scoreAfter - lastScore;
    lastScore = scoreAfter;
    if (!placed) {
      events.push({ block: blocks, placed: false, cleared: null, gain });
      continue;
    }

    // 4) 消行数由"空格数变化"精确反推（不靠分数猜，避免与软降 +1 混淆）
    const cleared = Math.round((countFilled(st.grid) + best.cellsInShape - countFilled(st2.grid)) / 10);
    const bonus = BONUS[cleared] ?? null;
    events.push({
      block: blocks,
      placed: true,
      cleared,
      bonus,
      gain,
      // 消行奖励必须落在 [bonus, bonus+25]（25 = 20 行软降的余量）；
      // 不要求精确相等：重力在移动/持按期间可能补一格，且重力不计分
      bonusOk: bonus === null ? gain >= 0 && gain <= 25 : gain >= bonus && gain <= bonus + 25,
      gridOk: JSON.stringify(mask(st2.grid)) === JSON.stringify(mask(best.kept)),
    });
  }

  const end = await readTetris(page);
  const valid = events.filter(e => e.placed);
  return {
    blocks,
    events,
    validEvents: valid,
    clearEvents: valid.filter(e => e.cleared > 0),
    droppedSamples: events.length - valid.length,
    gameOver: gameOver || end.gameOver,
    end,
    elapsed: Math.round((Date.now() - start) / 1000),
  };
}

/**
 * 有界自动玩（会输的策略）：只往固定几列堆，用于 TRIS-20（堆到顶部→游戏结束）。
 * 用启发式玩家堆不满（实测 150s/71 块仍在低高度），故这里刻意不用评估函数。
 */
export async function stackToGameOver(page, budgetMs = 120000) {
  const start = Date.now();
  let blocks = 0;
  let gameOver = false;
  let lastScore = 0;
  const gains = [];

  while (Date.now() - start < budgetMs) {
    const st = await readTetris(page);
    if (st.gameOver) {
      gameOver = true;
      break;
    }
    // 固定堆中间两列，几下就顶到天花板
    await moveToColumn(page, blocks % 2 === 0 ? 4 : 5);
    await holdSoftDrop(page, 1100);
    blocks++;
    const score = parseInt((await readTetris(page)).score);
    if (score > lastScore) gains.push(score - lastScore);
    lastScore = score;
  }

  const end = await readTetris(page);
  return { blocks, gameOver: gameOver || end.gameOver, end, elapsed: Math.round((Date.now() - start) / 1000), gains };
}

// ───────────────────────────── 视口/尺寸 ─────────────────────────────

export const viewportMetrics = page =>
  page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));

// ───────────────────────────── 爱情计时器 ─────────────────────────────

/** FluentSelect 不能靠"赋 value + 派发 change"驱动 Blazor，必须点击展开后点 fluent-option */
export async function pickSelect(page, idx, text) {
  await page.locator('fluent-select').nth(idx).click({ force: true });
  await sleep(420);
  const ok = await page.evaluate(
    ({ idx, text }) => {
      const s = document.querySelectorAll('fluent-select')[idx];
      const o = [...s.querySelectorAll('fluent-option')].find(x => x.textContent.trim() === text);
      if (!o) return false;
      o.click();
      return true;
    },
    { idx, text },
  );
  await sleep(850);
  return ok;
}

export const readLoveTime = page =>
  page.evaluate(() => {
    const sels = [...document.querySelectorAll('fluent-select')];
    const opts = i => [...sels[i].querySelectorAll('fluent-option')].map(o => o.textContent.trim());
    return {
      y: sels[0].value,
      m: sels[1].value,
      d: sels[2].value,
      yearCount: opts(0).length,
      dayOptions: opts(2),
      timers: [...document.querySelectorAll('div.timer')].map(t => t.textContent.trim()),
      tip: document.querySelector('.love-validation-tip')?.textContent.trim() || null,
    };
  });

export function parseTimer(s) {
  const m = /(\d+)\s*天,\s*(\d+)\s*小时,\s*(\d+)\s*分钟,\s*(\d+)\s*秒/.exec(s || '');
  return m ? { d: +m[1], h: +m[2], mi: +m[3], s: +m[4] } : null;
}

export const secsOf = p => p.mi * 60 + p.s;

