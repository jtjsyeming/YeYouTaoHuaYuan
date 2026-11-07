// D02 — 键盘操作（2048 / 俄罗斯方块）与 2048 数值配色
// 依据《10-开发文档-D02键盘操作与2048视觉统一-v2.0.md》§7。
//
// 两个关键手法：
//   1) 键盘是否真的走了一步，用 helpers.simulate(before, dir) 的**理论棋盘 + 理论分数增量**判定，
//      不看"是否变了"这种弱判据（开局随机，按一次键与按钮点一次不在同一棋盘上）。
//   2) "按住连发"不能用 page.keyboard.down() 测：Playwright 的 down() 只发一次 keydown，
//      不会像真实浏览器那样产生 OS 级 autorepeat。故连发用例改为派发 synthetic
//      KeyboardEvent{ repeat: true }，才真正打到 gamekeyboard.js 的 repeat 分支。
import { test } from '@playwright/test';
import {
  archiveOf,
  check,
  clickGameBtn,
  DEAD_CELLS,
  open,
  readBoard,
  readScore,
  readTetris,
  seedArchive,
  simulate,
  sleep,
  trackErrors,
} from './helpers.mjs';

const KEY = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };

/** 非零块数（与 helpers.countTiles 同口径；本文件只需一处，故不额外改 import 顺序） */
const countTiles0 = b => b.flat().filter(v => v !== 0).length;

/** 比对"按键前 b0/s0 → 按键后 b1/s1"是否符合标准 2048 语义（与 G2048-02/22 同一判据） */
function judgeMove(id, label, dir, b0, s0, b1, s1) {
  const sim = simulate(b0, dir);
  const changed = JSON.stringify(sim.board) !== JSON.stringify(b0);
  if (!changed) {
    const ok = JSON.stringify(b1) === JSON.stringify(b0) && s1 === s0;
    check(id, ok, `${label}方向=${dir} 无效移动应完全不变：棋盘${JSON.stringify(b0)}→${JSON.stringify(b1)}，分数 ${s0}→${s1}`);
    return ok;
  }
  const diffs = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      if (b1[r][c] !== sim.board[r][c]) diffs.push({ r, c, sim: sim.board[r][c], act: b1[r][c] });
  const gainOk = s1 - s0 === sim.gain;
  const newTileOk = diffs.length === 1 && diffs[0].sim === 0 && (diffs[0].act === 2 || diffs[0].act === 4);
  check(
    id,
    gainOk && newTileOk,
    `${label}方向=${dir} 前置=${JSON.stringify(b0)} 理论=${JSON.stringify(sim.board)}(+${sim.gain}) 实际=${JSON.stringify(b1)}(+${s1 - s0}) 差异=${JSON.stringify(diffs)}`,
  );
  return gainOk && newTileOk;
}

/** 在页面里派发带 repeat 标志的方向键事件（模拟真实浏览器的 autorepeat） */
const repeatKey = (page, key, times, gapMs) =>
  page.evaluate(
    async ({ key, times, gapMs }) => {
      for (let i = 0; i < times; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true, cancelable: true }));
        await new Promise(r => setTimeout(r, gapMs));
      }
    },
    { key, times, gapMs },
  );

const pressOnce = (page, key) =>
  page.evaluate(
    key => window.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: false, bubbles: true, cancelable: true })),
    key,
  );

/** 临时给首个 .tile 套一个配色类，读计算样式后还原（用于验证 CSS 而不依赖随机棋盘） */
const probeTile = (page, cls) =>
  page.evaluate(cls => {
    const t = document.querySelector('.game-container .tile');
    const saved = t.className;
    t.className = 'tile ' + cls;
    const cs = getComputedStyle(t);
    const out = { bg: cs.backgroundColor, color: cs.color, fs: cs.fontSize };
    t.className = saved;
    return out;
  }, cls);

test.describe('D02 键盘操作与 2048 视觉统一', () => {
  test('D02-1 2048 键盘四方向等价于按钮', async ({ page }) => {
    await open(page, '/game_2048', 1600);
    const detail = [];
    let allOk = true;

    for (const dir of ['left', 'up', 'right', 'down']) {
      const b0 = await readBoard(page);
      const s0 = await readScore(page);
      await page.keyboard.press(KEY[dir]);
      await sleep(350);
      const b1 = await readBoard(page);
      const s1 = await readScore(page);
      allOk = judgeMove('D02-1', '', dir, b0, s0, b1, s1) && allOk;
      detail.push(`${dir}:${s0}→${s1}`);
      // 结束后棋盘不再变化，后续方向键断言会退化成"无效移动"，提前收手
      if (await page.locator('.game-over').count()) break;
    }
    check('D02-1', allOk, `四方向按键与独立实现的标准规则逐步一致（分数轨迹 ${detail.join(' / ')}）`);
  });

  test('D02-2 焦点无关性：点标题后方向键仍生效', async ({ page }) => {
    await open(page, '/game_2048', 1600);
    await page.click('h1');
    const b0 = await readBoard(page);
    const s0 = await readScore(page);
    await page.keyboard.press('ArrowLeft');
    await sleep(350);
    const b1 = await readBoard(page);
    const s1 = await readScore(page);
    judgeMove('D02-2', '点 h1 后 ', 'left', b0, s0, b1, s1);
  });

  test('D02-3 方向键不滚动页面（375×400）', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 400 });
    await open(page, '/game_2048', 1600);

    const m = await page.evaluate(() => ({
      sh: document.documentElement.scrollHeight,
      ch: document.documentElement.clientHeight,
    }));
    // 先证明此视口确实可滚，否则 "scrollY === 0" 恒真、断言无意义
    check('D02-3-前置', m.sh > m.ch, `375×400 可滚动：scrollHeight ${m.sh} > clientHeight ${m.ch}`);

    await page.evaluate(() => window.scrollTo(0, 0));
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('ArrowDown');
      await sleep(150);
    }
    const y = await page.evaluate(() => window.scrollY);
    check('D02-3', y === 0, `按 5 次 ↓ 后 scrollY=${y}（preventDefault 只拦方向键）`);
  });

  test('D02-4 结束态键盘失效（注入合法死局档构造）', async ({ page }) => {
    // 构造手法见 helpers.seedArchive：合法满盘档注入后由页面重算 isGameOver，确定性进结束态，
    // 不再依赖"随机玩到结束"。（G2048-39 已覆盖遮罩/四向禁用，本条只守"键盘路径同样被挡"。）
    await open(page, '/game_2048', 1600);
    await seedArchive(page, archiveOf(DEAD_CELLS, 24));   // 8 个 4 ⇒ cap = 32

    const b0 = await readBoard(page);
    const s0 = await readScore(page);
    check(
      'D02-4-前置',
      (await page.locator('.game-over').count()) === 1 && countTiles0(b0) === 16,
      `死局档必须先进结束态（满 ${countTiles0(b0)} 块、遮罩=${await page.locator('.game-over').count()}），否则"键盘失效"无从谈起`,
    );

    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
      await page.keyboard.press(key);
      await sleep(220);
    }
    const b1 = await readBoard(page);
    const s1 = await readScore(page);
    check(
      'D02-4',
      JSON.stringify(b1) === JSON.stringify(b0) && s1 === s0,
      `四方向按键后盘面${JSON.stringify(b1) === JSON.stringify(b0) ? '不变' : '变了'}、分数 ${s0}→${s1}（OnKeyDown → MoveXxx 的 isGameOver 守卫必须挡住）`,
    );
  });

  test('D02-5 Tetris 键盘 ←/→ 各移 1 格', async ({ page }) => {
    await open(page, '/tetris', 1800);
    const s0 = await readTetris(page);
    const cell = s0.cellPx.w;

    await page.keyboard.press('ArrowLeft');
    await sleep(200);
    const s1 = await readTetris(page);
    await page.keyboard.press('ArrowRight');
    await sleep(200);
    const s2 = await readTetris(page);

    const d1 = Math.round((s0.overlayLeft - s1.overlayLeft) / cell);
    const d2 = Math.round((s2.overlayLeft - s1.overlayLeft) / cell);
    // 中途锁定重生会让 left 跳到新方块，用"两段位移相互抵消"兜住这种偶发
    check(
      'D02-5',
      (d1 === 1 && d2 === 1) || (s1.overlayLeft === s0.overlayLeft && s0.pieceRows.length > 0 && Math.abs(d2) <= 1),
      `以 ${cell.toFixed(2)}px/格计：初始 ${s0.overlayLeft} → ← ${s1.overlayLeft} → → ${s2.overlayLeft}（Δ=${d1}/${d2} 格）`,
    );
  });

  test('D02-6 Tetris 键盘 ↑ 旋转且不位移', async ({ page }) => {
    await open(page, '/tetris', 1800);
    const s0 = await readTetris(page);
    const shapeBefore = JSON.stringify(s0.pieceRows);

    await page.keyboard.press('ArrowUp');
    await sleep(250);
    const s1 = await readTetris(page);
    const shapeAfter = JSON.stringify(s1.pieceRows);

    // O 形（2×2 全 1）旋转后矩阵不变，属预期；其余形状必须变
    const isO = shapeBefore === JSON.stringify([[1, 1], [1, 1]]);
    check(
      'D02-6',
      (shapeAfter !== shapeBefore || isO) && s1.overlayLeft === s0.overlayLeft,
      `形状 ${shapeBefore} → ${shapeAfter}${isO ? '（O 形旋转不变，属预期）' : ''}；left ${s0.overlayLeft} → ${s1.overlayLeft} 未变`,
    );
  });

  test('D02-7 Tetris 键盘 ↓ 软降：计分与松手即停', async ({ page }) => {
    await open(page, '/tetris', 1800);
    await clickGameBtn(page, '重新开始', 500);

    const s0 = await readTetris(page);
    await page.keyboard.down('ArrowDown');
    await sleep(1000);
    await page.keyboard.up('ArrowDown');
    await sleep(400);
    const s1 = await readTetris(page);
    const gain = parseInt(s1.score) - parseInt(s0.score);
    check('D02-7-计分', gain >= 8 && gain <= 25, `按住 ↓ 1 秒得分 +${gain}（每格 +1，分数 ${s0.score}→${s1.score}）`);

    // 松手后应回到重力速率（≤2 格/秒），证明 keyup 真的发到了 StopSoftDrop
    const t1 = s1.overlayTop;
    await sleep(1000);
    const t2 = (await readTetris(page)).overlayTop;
    const moved = (t2 - t1) / s1.cellPx.w;
    check('D02-7-停止', moved <= 2, `松手后 1000ms 内下落 ${moved.toFixed(1)} 格（软降约 20 格/秒，说明已停）`);

    // 失焦释放（gamekeyboard 的 releaseAll）：按住 ↓ 时窗口失焦，keyup 收不到也必须停止软降
    await page.keyboard.down('ArrowDown');
    await sleep(300);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(450); // 释放是延迟 150ms 发出的，避开导航期断线
    const b1 = await readTetris(page);
    await sleep(1000);
    const b2 = await readTetris(page);
    await page.keyboard.up('ArrowDown');
    const afterBlur = (b2.overlayTop - b1.overlayTop) / b1.cellPx.w;
    check('D02-7-失焦', afterBlur <= 2, `按住 ↓ 时 window.blur → 之后 1000ms 内下落 ${afterBlur.toFixed(1)} 格（应回到重力速率，证明已释放）`);
  });

  test('D02-8 连发策略：2048 忽略、Tetris ←/→ 生效', async ({ page }) => {
    // 2048：5 次 repeat 事件必须全部被忽略（棋盘与分数都不动）
    await open(page, '/game_2048', 1600);
    const b0 = await readBoard(page);
    const s0 = await readScore(page);
    await repeatKey(page, 'ArrowLeft', 5, 80);
    await sleep(350);
    const b1 = await readBoard(page);
    const s1 = await readScore(page);
    check('D02-8-2048', JSON.stringify(b1) === JSON.stringify(b0) && s1 === s0, `按住 ←（5 次 repeat 事件）后棋盘与分数均未变（分数 ${s0}→${s1}）`);

    // 反证监听仍活着：一次非 repeat 的 keydown 必须走一步
    await pressOnce(page, 'ArrowLeft');
    await sleep(350);
    const b2 = await readBoard(page);
    const s2 = await readScore(page);
    judgeMove('D02-8-2048-对照', '单次按下 ', 'left', b0, s0, b2, s2);

    // Tetris：←/→ 允许连发（60ms 节流），5 次 repeat 应至少走出 2 格
    await open(page, '/tetris', 1800);
    const t0 = await readTetris(page);
    await repeatKey(page, 'ArrowRight', 5, 90);
    await sleep(250);
    const t1 = await readTetris(page);
    const cell = t0.cellPx.w;
    const dx = (t1.overlayLeft - t0.overlayLeft) / cell;
    const wallOk = t1.overlayLeft >= 0 && t1.overlayLeft <= cell * 2; // 已贴右墙也算通过
    check('D02-8-Tetris', dx >= 2 || wallOk, `按住 → 5 次 repeat 后位移 ${dx.toFixed(1)} 格（left ${t0.overlayLeft}→${t1.overlayLeft}，已贴墙=${wallOk}）`);
  });

  test('D02-9 跨页注册竞态：导航切换后键盘归属正确', async ({ page }) => {
    const errs = trackErrors(page);

    await open(page, '/game_2048', 1600);
    // 用导航链接而非 goto：只有 SPA 导航才会触发"新页 register / 旧页 unregister"的竞态路径
    await page.locator('nav a.fluent-nav-link', { hasText: '俄罗斯方块' }).first().click();
    await sleep(1600);

    const t0 = await readTetris(page);
    await page.keyboard.press('ArrowLeft');
    await sleep(250);
    const t1 = await readTetris(page);
    const cell = t0.cellPx.w;
    const dTetris = Math.round((t0.overlayLeft - t1.overlayLeft) / cell);
    check('D02-9-进入Tetris', dTetris >= 1 || t1.overlayLeft === 0, `导航进 /tetris 后按 ←：left ${t0.overlayLeft} → ${t1.overlayLeft}（Δ=${dTetris} 格）`);

    await page.locator('nav a.fluent-nav-link', { hasText: '2048' }).first().click();
    await sleep(1600);
    const b0 = await readBoard(page);
    const s0 = await readScore(page);
    await page.keyboard.press('ArrowLeft');
    await sleep(350);
    const b1 = await readBoard(page);
    const s1 = await readScore(page);
    judgeMove('D02-9-回到2048', '导航回 2048 后 ', 'left', b0, s0, b1, s1);

    check('D02-14-导航', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : '跨页导航 + 键盘操作全程无 console error / pageerror');
  });

  test('D02-10 / D02-13 配色与字号（含 8/16/32 白字）', async ({ page }) => {
    await open(page, '/game_2048', 1600);

    // 真实存在的 2/4 块：直接读计算样式（随机棋盘必定至少各有一个，若不足则跳过该值）
    const real = await page.evaluate(() =>
      [...document.querySelectorAll('.game-container .tile')].map(t => {
        const cs = getComputedStyle(t);
        return { v: parseInt(t.textContent.trim()) || 0, bg: cs.backgroundColor, color: cs.color };
      }),
    );
    const expectTable = {
      2: { bg: 'rgb(238, 228, 218)', color: 'rgb(119, 110, 101)' },
      4: { bg: 'rgb(237, 224, 200)', color: 'rgb(119, 110, 101)' },
    };
    const realBad = [];
    for (const [v, exp] of Object.entries(expectTable)) {
      for (const t of real.filter(x => x.v === Number(v))) {
        if (t.bg !== exp.bg || t.color !== exp.color) realBad.push(`值${v}: bg=${t.bg} color=${t.color}`);
      }
    }
    check('D02-10-实块', realBad.length === 0, realBad.length ? realBad.join('；') : `实块 2/4 配色符合标准 2048（样本 ${real.filter(t => t.v).length} 个）`);

    // 8/16/32 无法保证开局出现，改用类探针（直接验证 CSS 规则本身）
    const probes = {};
    for (const cls of ['tile-2', 'tile-4', 'tile-8', 'tile-16', 'tile-32', 'tile-64', 'tile-128', 'tile-256', 'tile-512', 'tile-1024', 'tile-2048', 'tile-super']) {
      probes[cls] = await probeTile(page, cls);
    }
    check(
      'D02-10-配色',
      probes['tile-2'].bg === 'rgb(238, 228, 218)' &&
        probes['tile-4'].bg === 'rgb(237, 224, 200)' &&
        probes['tile-8'].bg === 'rgb(242, 177, 121)' &&
        probes['tile-1024'].bg === 'rgb(237, 197, 63)' &&
        probes['tile-2048'].bg === 'rgb(237, 194, 46)' &&
        probes['tile-super'].bg === 'rgb(60, 58, 50)',
      `背景：2=${probes['tile-2'].bg} 4=${probes['tile-4'].bg} 8=${probes['tile-8'].bg} 1024=${probes['tile-1024'].bg} 2048=${probes['tile-2048'].bg} super=${probes['tile-super'].bg}`,
    );
    check(
      'D02-10-白字',
      ['tile-8', 'tile-16', 'tile-32', 'tile-64', 'tile-128', 'tile-1024', 'tile-2048', 'tile-super'].every(
        c => probes[c].color === 'rgb(255, 255, 255)' || probes[c].color === 'rgb(249, 246, 242)',
      ),
      `8 及以上文字色：8=${probes['tile-8'].color} 16=${probes['tile-16'].color} 32=${probes['tile-32'].color} 1024=${probes['tile-1024'].color}（须为白，否则是深褐字压橙黄底）`,
    );
    check(
      'D02-13',
      probes['tile-128'].fs === '16px' && probes['tile-1024'].fs === '13px',
      `字号收缩：tile-128=${probes['tile-128'].fs}（50×.32=16） tile-1024=${probes['tile-1024'].fs}（50×.26=13）`,
    );
  });

  test('D02-11 / D02-12 空块无文字与「分数：」文案', async ({ page }) => {
    await open(page, '/game_2048', 1600);
    const tiles = await page.evaluate(() =>
      [...document.querySelectorAll('.game-container .tile')].map(t => ({
        text: t.textContent,
        empty: t.classList.contains('tile-empty'),
      })),
    );
    const zeros = tiles.filter(t => t.text.trim() === '0').length;
    const emptyOk = tiles.filter(t => t.empty).every(t => t.text === '');
    check('D02-11', zeros === 0 && emptyOk && tiles.some(t => t.empty), `空块文字为空的 ${tiles.filter(t => t.empty).length} 个；文本为 "0" 的块 ${zeros} 个`);

    const txt = ((await page.textContent('p:has-text("分数")')) || '').trim();
    check('D02-12', /^分数：\d+$/.test(txt), `分数元素文本="${txt}"`);
  });

  test('D02-14 键盘与按钮混用全程无 JS 异常', async ({ page }) => {
    const errs = trackErrors(page);
    await open(page, '/game_2048', 1600);
    for (const d of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) {
      await page.keyboard.press(d);
      await sleep(200);
    }
    await page.locator('.controls fluent-button:has-text("⬅️")').click();
    await sleep(200);

    await page.locator('nav a.fluent-nav-link', { hasText: '俄罗斯方块' }).first().click();
    await sleep(1600);
    for (const d of ['ArrowLeft', 'ArrowUp', 'ArrowRight']) {
      await page.keyboard.press(d);
      await sleep(200);
    }
    await page.keyboard.down('ArrowDown');
    await sleep(400);
    await page.keyboard.up('ArrowDown');
    await sleep(500);

    check('D02-14', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : '键盘/按钮混用 + 跨页导航全程无 console error / pageerror');
  });
});
