// D-17：2048 对局进度会话保持（sessionStorage `jtjsym.g2048.session`）
// 手法：断言一律"盘面签名 + 分数 + 存档原文"三方对照。只比"2 块、0 分"测不出恢复
//      —— 恢复失败时新开局的形态与期望完全一样，必须比具体盘面才具备判别力。
import { expect, test } from '@playwright/test';
import {
  check, checkEq, clickDir, countTiles, open, readBest, readBoard, readScore, readSession, sleep, trackErrors,
} from './helpers.mjs';

const BEST_KEY = 'jtjsym.g2048.best';
const DIRS = ['left', 'down', 'right', 'up'];

/** 盘面签名：16 格按行拼成字符串，用于"是否同一盘面"的精确比对 */
const sig = b => b.map(r => r.join(',')).join('|');

/** 站内切页往返（客户端路由：组件会 Dispose，再回来是新实例 —— D-17 的主场景） */
async function leaveAndReturn(page) {
  await page.locator('nav a.fluent-nav-link', { hasText: 'jtjsym' }).first().click();   // 回首页
  await sleep(1200);
  await page.locator('nav a.fluent-nav-link', { hasText: '2048' }).first().click();     // 再进 2048
  await sleep(400);            // 恢复在 firstRender，毫秒级；真等不到交给 expect.poll 判红
}

/** 走子直到分数 ≥ min（2048 前几步必有合并）。打死就停，别点重玩——重开会把存档覆盖掉。 */
async function playUntilScore(page, min = 4, max = 30) {
  for (let i = 0; i < max && (await readScore(page)) < min; i++) {
    if (await page.locator('.game-over').count()) return false;
    await clickDir(page, DIRS[i % 4]);
  }
  return (await readScore(page)) >= min;
}

const waitBoard = (page, s) => expect.poll(async () => sig(await readBoard(page)), { timeout: 7000 }).toBe(s);

test.describe('D17 2048 对局进度会话保持', () => {
  test('G2048-30 无存档首进：2 块开局且不写档', async ({ page }) => {
    await open(page, '/game_2048', 1800);
    const b = await readBoard(page);
    checkEq(
      'G2048-30',
      { tiles: countTiles(b), score: await readScore(page), archive: await readSession(page) },
      { tiles: 2, score: 0, archive: null },
      '初始化那次 RestartGame 不得落盘 —— 一旦落盘就会冲掉上次的存档，这是 D-17 最容易写错的地方',
    );
  });

  test('G2048-31 站内切页往返：盘面与分数原样恢复', async ({ page }) => {
    await open(page, '/game_2048', 1800);
    const ok = await playUntilScore(page);
    const b = await readBoard(page);
    const s = await readScore(page);
    check('G2048-31-前置', ok && s > 0, `已走子到分数 ${s}（盘面 ${sig(b)}）`);
    check('G2048-31-存档', (await readSession(page)) !== null, '每步有效移动后应有存档');

    await leaveAndReturn(page);
    await waitBoard(page, sig(b));
    await expect.poll(() => readScore(page), { timeout: 7000 }).toBe(s);
  });

  test('G2048-32 刷新：进度保持（sessionStorage 跨刷新）', async ({ page }) => {
    await open(page, '/game_2048', 1800);
    await playUntilScore(page);
    const b = await readBoard(page);
    const s = await readScore(page);
    check('G2048-32-前置', s > 0, `刷新前分数 ${s}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await waitBoard(page, sig(b));
    await expect.poll(() => readScore(page), { timeout: 7000 }).toBe(s);
  });

  test('G2048-33 重玩后切页回来：是新局而非旧档', async ({ page }) => {
    await open(page, '/game_2048', 1800);
    await playUntilScore(page);
    const oldSig = sig(await readBoard(page));

    await page.locator('.replay-btn').first().click();
    await sleep(600);
    const b2 = await readBoard(page);
    const s2 = await readScore(page);
    check('G2048-33-重玩', countTiles(b2) === 2 && s2 === 0, `重玩后 ${countTiles(b2)} 块、分数 ${s2}`);
    // 判据自检：新局盘面必须与旧局不同，否则下面"恢复成哪一局"根本分不出来
    check('G2048-33-换盘', sig(b2) !== oldSig, '重玩必须换一块新盘');

    await leaveAndReturn(page);
    // 覆盖 → 回来是 b2；若实现成"清除存档"→ 回来是第三块随机盘，签名不符即红
    await waitBoard(page, sig(b2));
    await expect.poll(() => readScore(page), { timeout: 7000 }).toBe(0);
  });

  test('G2048-34 坏档容错：非 JSON / 版本不符 / 缺字段 / 长度不符 → 均新局', async ({ page }) => {
    const errs = trackErrors(page);
    const bad = [
      'xyz',                                                              // 非 JSON
      JSON.stringify({ v: 2, cells: Array(16).fill(0), score: 0 }),        // 版本不符
      JSON.stringify({ v: 1 }),                                            // 缺 cells（易 NRE 的那条）
      JSON.stringify({ v: 1, cells: [2, 4], score: 9 }),                   // 长度不符
    ];

    await open(page, '/game_2048', 1800);
    const rows = [];
    for (const payload of bad) {
      await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), ['jtjsym.g2048.session', payload]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
      await sleep(900);
      const b = await readBoard(page);
      rows.push({ payload: payload.slice(0, 26), tiles: countTiles(b), score: await readScore(page) });
    }
    check('G2048-34', rows.every(r => r.tiles === 2 && r.score === 0), JSON.stringify(rows));
    check('G2048-34-无异常', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : '4 种坏档全程无 console error / pageerror');
  });

  test('G2048-35 与最高分协同：预置 500，恢复不得改写纪录', async ({ page }) => {
    // 只在键不存在时写：addInitScript 每次导航（含 reload）都会重跑，无条件写会把刚破的纪录冲掉
    await page.addInitScript(
      ([k, v]) => { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); },
      [BEST_KEY, '500'],
    );
    await open(page, '/game_2048', 1800);
    await playUntilScore(page);
    const b = await readBoard(page);
    const s = await readScore(page);
    check('G2048-35-前置', s > 0 && s < 500, `分数 ${s} 须落在 (0,500) 内，才能验证"恢复不会把纪录冲成当前分"`);

    await leaveAndReturn(page);
    await expect.poll(() => readBest(page), { timeout: 7000 }).toBe(500);   // ← 恢复若排在读 best 之前，这里会是当前分
    await waitBoard(page, sig(b));
    await expect.poll(() => readScore(page), { timeout: 7000 }).toBe(s);
  });

  test('G2048-36 会话边界：新上下文全新开局（证明用的是 sessionStorage 而非 localStorage）', async ({ page, browser }) => {
    await open(page, '/game_2048', 1800);
    await playUntilScore(page);
    check('G2048-36-前置', (await readSession(page)) !== null, '本上下文已有存档');

    const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin });
    const p2 = await ctx.newPage();
    try {
      await open(p2, '/game_2048', 1800);
      const b = await readBoard(p2);
      checkEq(
        'G2048-36',
        { tiles: countTiles(b), score: await readScore(p2), archive: await readSession(p2) },
        { tiles: 2, score: 0, archive: null },
        '新标签/新会话不得继承上一会话的残局 —— 换成 localStorage 实现时这条必红',
      );
      check('G2048-36-原会话', (await readSession(page)) !== null, '原上下文存档不受另一个上下文影响');
    } finally {
      await ctx.close();
    }
  });
});
