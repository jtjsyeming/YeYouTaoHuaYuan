// D-24：俄罗斯方块对局会话保持（sessionStorage `jtjsym.tetris.session`）+ 后台自动暂停
// D-25：最高分落盘加固（每个锁定点 + DisposeAsync）
//
// 三个 Tetris 特有的坑，别照抄 2048 的 d17：
//   ① 快照只在**锁定点**产生（一块落下、消行结算、新块出生）。软降在半空攒的分不进快照 ——
//      所以"离开前分数 == 回来后分数"不成立，允许 ≤25 的倒挂（当前块下落进度的零头，见《33》§2.2）。
//   ② 恢复后一律**暂停态**（`.continue-btn` 可见）—— 与 2048"恢复即玩"刻意不同（实时 timer vs 回合制）。
//   ③ 落盘全是 fire-and-forget，读 localStorage / sessionStorage 一律走 expect.poll，点完立刻读会假红。
import { expect, test } from '@playwright/test';
import {
  EMPTY_COLOR,
  check,
  checkEq,
  holdSoftDrop,
  open,
  readBest,
  readTetris,
  sleep,
  trackErrors,
} from './helpers.mjs';

const SK = 'jtjsym.tetris.session';
const BK = 'jtjsym.tetris.best';

/** 盘面签名：20 行 × 10 格的颜色串。比"空了几格"更有判别力 —— 恢复失败时新开局也是全空。 */
const sig = st => st.grid.map(r => r.join(',')).join('|');
const filled = st => st.cells.filter(c => c !== EMPTY_COLOR).length;

const readSession = page => page.evaluate(k => sessionStorage.getItem(k), SK);
const storedBest = page => page.evaluate(k => localStorage.getItem(k), BK);

/** 站内切页往返（客户端路由：组件 Dispose → 新 circuit 回来。这是 D-24 的主场景） */
async function leaveAndReturn(page, settle = 500) {
  await page.locator('nav a.fluent-nav-link', { hasText: 'jtjsym' }).first().click();
  await sleep(1200);
  await page.locator('nav a.fluent-nav-link', { hasText: '俄罗斯方块' }).first().click();
  await sleep(settle); // 恢复在 firstRender，毫秒级；真等不到交给 expect.poll 判红
}

/** 直写存档 + reload。⚠ 不要用 addInitScript：它每次导航都会重跑，会冲掉"恢复后新写的档"。 */
async function seedSession(page, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [SK, text]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(900);
}

const emptyGrid = () => Array.from({ length: 20 }, () => Array(10).fill(0));

/** 与页面同结构的合法快照载荷；over 覆盖任意字段。默认：空盘、O 形在第 0 行、1 级 1000ms。 */
const snapOf = (over = {}) => ({
  v: 1,
  grid: emptyGrid(),
  piece: [[1, 1], [1, 1]],
  pieceIndex: 3,
  x: 3,
  y: 0,
  next: [[1, 1, 1, 1]],
  nextIndex: 5,
  score: 0,
  level: 1,
  speed: 1000,
  ...over,
});

/** 注入/还原可见性并派发 visibilitychange（与 d08 同手法：遮蔽实例上的 getter）。 */
const setVisibility = (page, state) =>
  page.evaluate(s => {
    if (s === null) {
      delete document.visibilityState;
    } else {
      Object.defineProperty(document, 'visibilityState', { get: () => s, configurable: true });
    }
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

test.describe('D24 俄罗斯方块对局会话保持', () => {
  test('D24-1 站内切页往返：盘面逐格恢复 + 呈暂停态', async ({ page }) => {
    await open(page, '/tetris', 1800);
    await holdSoftDrop(page, 1400);   // 至少锁一块：快照只在锁定点产生（快照时机见《33》§2.2）
    await sleep(400);

    const before = await readTetris(page);
    const s = sig(before);
    const raw = await readSession(page);
    check('D24-1-前置', filled(before) > 0 && raw !== null, `已锁定 ${filled(before)} 格；快照=${raw ? '已生成' : '为空'}`);
    if (!raw) return;                 // 没有快照就没法验恢复，后面全是假红

    const snap = JSON.parse(raw);

    await leaveAndReturn(page);
    await expect.poll(async () => sig(await readTetris(page)), { timeout: 8000 }).toBe(s);

    const after = await readTetris(page);
    const gap = Number(before.score) - Number(after.score);
    checkEq(
      'D24-1',
      { paused: after.paused, score: after.score, level: after.difficulty },
      { paused: true, score: String(snap.score), level: String(snap.level) },
      '恢复后必须是暂停态，分数/等级取自快照而非重算',
    );
    // 允许 ≤25 的倒挂：离开前那一块可能还在半空，软降攒的零头不进快照（《33》§2.2 明写接受）
    check(
      'D24-1-零头',
      gap >= 0 && gap <= 25,
      `离开前 ${before.score} → 回来 ${after.score}（Δ=${gap}，允许 0~25：软降零头不落盘，消行与锁定点已固化）`,
    );
  });

  test('D24-2 对局结束后回来：不恢复旧局（新局、无结束遮罩）', async ({ page }) => {
    await open(page, '/tetris', 1500);
    // 造一个"顶到天花板"的合法档：第 1~19 行填到只剩第 9 列（= 171 格），第 0 行留给出生位。
    // ⚠ 不能填**满**：19 行全满会在锁定那一刻被 ClearRows 一次清掉（`_ => 100 * rowsCleared` = 1900 分），
    //   棋盘瞬间清空，于是永远到不了 GameOver —— 首版就是这么红的（分数 1900、难度 1、无遮罩）。
    //   留一列空 = 每行都不完整 ⇒ 不清行，而新块出生位仍在第 0 行，两三拍内必结束。
    const grid = emptyGrid();
    for (let r = 1; r < 20; r++) grid[r] = Array.from({ length: 10 }, (_, c) => (c === 9 ? 0 : 4));
    await seedSession(page, snapOf({ grid, piece: [[1, 1, 1, 1]], x: 0, y: 0 }));

    const restored = await readTetris(page);
    check('D24-2-前置', restored.paused && filled(restored) === 171, `恢复后暂停=${restored.paused}，已占格=${filled(restored)}（期望 171）`);

    await page.locator('.continue-btn').click();
    await expect.poll(async () => (await readTetris(page)).gameOver, { timeout: 20000 }).toBe(true);

    // GameOver 的第一件事就是清档 —— 结束态没有"可恢复"的语义
    await expect.poll(() => readSession(page), { timeout: 5000 }).toBeNull();

    await leaveAndReturn(page);
    await sleep(800);
    const after = await readTetris(page);
    checkEq(
      'D24-2',
      { gameOver: after.gameOver, score: after.score, filled: filled(after) },
      { gameOver: false, score: '0', filled: 0 },
      '结束态不得被存成可恢复档：回来应是全新一局，且没有残留的"游戏结束!"遮罩',
    );
  });

  test('D24-3 重玩后切页回来：不恢复旧局（快照已清除）', async ({ page }) => {
    await open(page, '/tetris', 1500);
    // 旧局留两行（各 9 格，故意不填满 —— 真实的存档里不可能存在"满行"）+ 120 分，
    // 确保"恢复成哪一局"分得出来
    const grid = emptyGrid();
    for (const r of [18, 19]) grid[r] = Array.from({ length: 10 }, (_, c) => (c === 9 ? 0 : 4));
    await seedSession(page, snapOf({ grid, piece: [[1, 1], [1, 1]], x: 3, y: 2, score: 120, level: 2, speed: 900 }));

    const restored = await readTetris(page);
    check('D24-3-前置', restored.paused && restored.score === '120' && filled(restored) === 18, `恢复后 暂停=${restored.paused} 分数=${restored.score} 占用=${filled(restored)}`);

    await page.locator('.restart-btn').click();
    // 重玩 = 弃掉旧局：快照必须立刻清掉（清档与写盘都是 fire-and-forget，必须 poll）
    await expect.poll(() => readSession(page), { timeout: 5000 }).toBeNull();
    // ⚠ 清档 poll 只证明"服务端处理了这发 click"，**DOM 回流还要再晚一拍**。
    //    D22-5 在 2026-11-10 的 test:pr 里就是这么假红的（读到点击前的分数）。这里同样 poll。
    await expect
      .poll(
        async () => {
          const f = await readTetris(page);
          return `${f.score}/${filled(f)}/${f.paused}`;
        },
        { timeout: 5000 },
      )
      .toBe('0/0/false');

    const fresh = await readTetris(page);
    check('D24-3-重玩', fresh.score === '0' && filled(fresh) === 0 && !fresh.paused, `重玩后 分数=${fresh.score} 占用=${filled(fresh)} 暂停=${fresh.paused}`);

    await leaveAndReturn(page);
    await sleep(800);
    const after = await readTetris(page);
    checkEq(
      'D24-3',
      { score: after.score, filled: filled(after) },
      { score: '0', filled: 0 },
      '回来不得是那局 120 分/两行实心的旧局（回来是暂停态属预期：新局本身也会被存成快照）',
    );
  });

  test('D24-4 坏档容错：每种坏档都整档丢弃、开新局、无异常', async ({ page }) => {
    const errs = trackErrors(page);
    const grid = emptyGrid();
    grid[19] = Array(10).fill(4);
    const collisionGrid = emptyGrid();
    collisionGrid[0][3] = 4;         // 出生位（O 形在 x=3,y=0）已被占

    const bad = [
      ['非 JSON', 'xyz'],
      ['版本不符', snapOf({ v: 2 })],
      ['缺 grid', { ...snapOf(), grid: undefined }],
      ['grid 19 行', { ...snapOf(), grid: grid.slice(1) }],
      ['格值 8（上界 7）', (() => { const g = emptyGrid(); g[19][9] = 8; return snapOf({ grid: g }); })()],
      ['x=10 越右界', snapOf({ x: 10 })],
      ['speed=50 低于地板', snapOf({ speed: 50 })],
      ['出生位碰撞', snapOf({ grid: collisionGrid })],
    ];

    await open(page, '/tetris', 1500);
    const rows = [];
    for (const [name, payload] of bad) {
      await seedSession(page, payload);
      const st = await readTetris(page);
      rows.push({ name, score: st.score, filled: filled(st), paused: st.paused, go: st.gameOver });
    }
    check(
      'D24-4',
      rows.every(r => r.score === '0' && r.filled === 0 && !r.go && !r.paused),
      JSON.stringify(rows) + '（每行都必须是"全空、0 分、运行中"的新局 —— 半恢复会留下棋盘或暂停态）',
    );
    check('D24-4-无异常', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : '8 种坏档全程无 console error / pageerror');
  });

  test('D24-5 恢复后按「继续游戏」：timer 真的续跑，速度与快照 level 一致', async ({ page }) => {
    await open(page, '/tetris', 1500);
    await seedSession(page, snapOf({ score: 120, level: 3, speed: 900 }));

    const r = await readTetris(page);
    check('D24-5-恢复', r.paused && r.difficulty === '3' && r.score === '120', `暂停=${r.paused} 难度=${r.difficulty} 分数=${r.score}`);

    // 对照组：暂停期间必须一动不动（否则"续跑"判据恒真）
    const t0 = (await readTetris(page)).overlayTop;
    await sleep(1200);
    const t1 = (await readTetris(page)).overlayTop;
    check('D24-5-暂停对照', t0 === t1, `暂停 1.2s 内 overlay.top ${t0} → ${t1}（应完全一致）`);

    await page.locator('.continue-btn').click();
    await sleep(2000);
    const s2 = await readTetris(page);
    const rowsMoved = (s2.overlayTop - t1) / s2.cellPx.h;
    check(
      'D24-5',
      rowsMoved >= 1 && rowsMoved <= 4,
      `继续 2s 后下落 ${rowsMoved.toFixed(1)} 行（speed=900ms/行 ⇒ 期望 2，容差 1~4）`,
    );
  });

  test('D24-6 切后台：同 circuit 直接呈现暂停态，棋盘不偷偷变化', async ({ page }) => {
    await open(page, '/tetris', 1800);
    await holdSoftDrop(page, 900);   // 让盘面上有点内容，避免"空盘不变"这种恒真判据
    await sleep(600);
    const before = await readTetris(page);
    check('D24-6-前置', !before.paused && !before.gameOver, `注入前 暂停=${before.paused} 结束=${before.gameOver}`);

    await setVisibility(page, 'hidden');
    await expect.poll(async () => (await readTetris(page)).paused, { timeout: 6000 }).toBe(true);

    const p1 = await readTetris(page);
    await sleep(1500);
    const p2 = await readTetris(page);
    check(
      'D24-6',
      p1.overlayTop === p2.overlayTop && sig(p1) === sig(p2) && !p2.gameOver,
      `后台 1.5s：overlay.top ${p1.overlayTop} → ${p2.overlayTop}，盘面一致=${sig(p1) === sig(p2)}，结束=${p2.gameOver}`,
    );

    // 只监听 hidden、不监听 visible：回前台不自动续跑（一切"回来"都是暂停待继续）
    await setVisibility(page, null);
    await sleep(600);
    const v = await readTetris(page);
    check('D24-6-不自动续跑', v.paused, `回前台后 暂停=${v.paused}（期望 true，需用户点「继续游戏」）`);

    await page.locator('.continue-btn').click();
    await sleep(1600);
    const v2 = await readTetris(page);
    check(
      'D24-6-续跑',
      v2.overlayTop > v.overlayTop || sig(v2) !== sig(v),
      `继续 1.6s 后 overlay.top ${v.overlayTop} → ${v2.overlayTop}，盘面变化=${sig(v2) !== sig(v)}（应至少发生其一）`,
    );
  });

  test('D24-7 软降攒分且一块未锁 → 切页：最高分不丢（D-25）', async ({ page }) => {
    await open(page, '/tetris', 1500);
    await holdSoftDrop(page, 500);    // 只攒分：10 拍左右，方块还在半空 ⇒ 没有任何锁定点落盘
    const mid = await readTetris(page);
    const s = Number(mid.score);
    const ls0 = await storedBest(page);
    check(
      'D24-7-前置',
      s > 0 && ls0 === null,
      `软降攒到 ${s} 分，localStorage=${ls0 === null ? 'null' : JSON.stringify(ls0)}（期望 null：软降的 +1 不逐分落盘）`,
    );

    await leaveAndReturn(page);
    // 这就是 D-25 补的那一刀：弃局时若只靠"锁定点/消行"，这 ${s} 分永远写不进盘
    await expect.poll(() => readBest(page), { timeout: 8000 }).toBe(s);
    check('D24-7-落盘', (await storedBest(page)) === String(s), `离开后 localStorage=${await storedBest(page)}（期望 ${s}）`);

    // localStorage 跨刷新（sessionStorage 只在标签页会话内）—— 刷新后最高分仍在
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await expect.poll(() => readBest(page), { timeout: 8000 }).toBe(s);
  });
});
