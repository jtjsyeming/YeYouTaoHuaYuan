// D-16：2048 最高分持久化（localStorage `jtjsym.g2048.best`）
// 手法：预置/直读都走 localStorage，断言一律"页面文案 + 存储值"双向核对；
//      需要得分时按方向循环走子（2048 前几步必有合并），不依赖固定棋盘。
import { expect, test } from '@playwright/test';
import { check, checkEq, open, readBest, readScore, sleep } from './helpers.mjs';

const KEY = 'jtjsym.g2048.best';
const DIRS = ['⬅️', '⬇️', '➡️', '⬆️'];

/** ⚠ addInitScript 在每次导航（含 reload）都会重跑，故只在键不存在时预置；
 *  无条件写会把上一局刚存下的值冲掉，让"刷新后保持"变成永远为真的假绿。 */
const seedBest = (page, val) =>
  page.addInitScript(
    ([k, v]) => {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    },
    [KEY, val],
  );

const stored = page => page.evaluate(k => localStorage.getItem(k), KEY);

async function step(page, i) {
  if (await page.locator('.game-over').count()) {   // 已结束：按钮 disabled，先重开
    await page.locator('.overlay-replay-btn').click();
    await sleep(300);
    return;
  }
  await page.locator(`.controls fluent-button:has-text("${DIRS[i % 4]}")`).click();
  await sleep(220);
}

async function playUntil(page, pred, maxMoves = 40) {
  for (let i = 0; i < maxMoves; i++) {
    if (await pred()) return true;
    await step(page, i);
  }
  return pred();
}

test.describe('D16 2048 最高分', () => {
  test('G2048-24 读取：预置 500 → 最高分 500、当前分 0', async ({ page }) => {
    await seedBest(page, '500');
    await open(page, '/game_2048', 1600);
    checkEq('G2048-24', { best: await readBest(page), score: await readScore(page) },
      { best: 500, score: 0 }, '历史最高分应被读出且不影响当前分');
  });

  test('G2048-25 容错：损坏值 "abc" → 最高分 0、游戏可正常开局', async ({ page }) => {
    await seedBest(page, 'abc');
    await open(page, '/game_2048', 1600);
    const tiles = (await page.$$eval('.game-container .tile', ts => ts.map(t => t.textContent.trim())))
      .filter(Boolean).length;
    checkEq('G2048-25', { best: await readBest(page), tiles }, { best: 0, tiles: 2 },
      '损坏值按 0 处理，开局不受影响');
  });

  test('G2048-26 写入：得分超过预置值 → 最高分跟进并落盘', async ({ page }) => {
    await seedBest(page, '2');                       // 首次合并（+4）即超越，无需打满 500
    await open(page, '/game_2048', 1600);
    const ok = await playUntil(page, async () => (await readBest(page)) > 2);
    const best = await readBest(page);
    const score = await readScore(page);
    check('G2048-26-跟进', ok && best === score, `最高分 ${best} 与当前分 ${score} 同步（预置 2）`);
    await expect.poll(() => stored(page), { timeout: 5000 }).toBe(String(best));  // 等 fire-and-forget 落盘
  });

  test('G2048-27 刷新：进度保持、最高分保持（D-17 起分数不再归零）', async ({ page }) => {
    await open(page, '/game_2048', 1600);            // 不预置：让值完全来自本次写入
    await playUntil(page, async () => (await readScore(page)) > 0);
    const best = await readBest(page);
    const score = await readScore(page);
    check('G2048-27-前置', best === score && score > 0, `破纪录态：最高分 ${best} = 当前分 ${score}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await expect.poll(() => readScore(page), { timeout: 7000 }).toBe(score);   // 原为 toBe(0)
    await expect.poll(() => readBest(page), { timeout: 7000 }).toBe(best);
  });

  test('G2048-28 重玩：分数归零、最高分保持', async ({ page }) => {
    await open(page, '/game_2048', 1600);
    await playUntil(page, async () => (await readScore(page)) > 0);
    const best = await readBest(page);
    await page.locator('.replay-btn').first().click();
    await sleep(400);
    checkEq('G2048-28', { score: await readScore(page), best: await readBest(page) },
      { score: 0, best }, '重开不得清最高分');
  });

  test('G2048-29 跨路由：离开再回来最高分保持', async ({ page }) => {
    await open(page, '/game_2048', 1600);
    await playUntil(page, async () => (await readScore(page)) > 0);
    const best = await readBest(page);
    await open(page, '/', 1200);
    await open(page, '/game_2048', 1600);
    await expect.poll(() => readBest(page), { timeout: 7000 }).toBe(best);
  });
});
