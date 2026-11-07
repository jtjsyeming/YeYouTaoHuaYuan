// 18：2048 存档数据完整性加固（P-002/P-003/P-004/P-005）
// 手法：坏档一律 page.evaluate 直写 sessionStorage 后 reload（**不要** addInitScript —— 它每次导航都会重跑）；
//      判据必须能区分"恢复了这一局"与"退化成新局"，否则两边都是 2 块 0 分，等于恒真。
import { expect, test } from '@playwright/test';
import {
  SESSION_KEY, check, checkEq, clickDir, countTiles, open, readBest, readBoard, readScore, readSession, sleep,
} from './helpers.mjs';

const BEST_KEY = 'jtjsym.g2048.best';
const sig = b => b.map(r => r.join(',')).join('|');
const storedBest = page => page.evaluate(k => localStorage.getItem(k), BEST_KEY);

/** 直写存档 + reload（调用前页面必须已在本 origin 上） */
async function seed(page, payload) {
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [SESSION_KEY, JSON.stringify(payload)]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(900);
}

const zeros = (n = 16) => Array(n).fill(0);
const cellsOf = list => { const c = zeros(); list.forEach((v, i) => (c[i] = v)); return c; };
const archive = (list, score) => ({ v: 1, cells: cellsOf(list), score });

/** 走子直到分数 ≥ min（2048 前几步必有合并）；打出结束态就返回 false */
async function playUntilScore(page, min = 100, max = 60) {
  const DIRS = ['left', 'down', 'right', 'up'];
  for (let i = 0; i < max && (await readScore(page)) < min; i++) {
    if (await page.locator('.game-over').count()) return false;
    await clickDir(page, DIRS[i % 4]);
  }
  return (await readScore(page)) >= min;
}

test.describe('18 2048 存档数据完整性', () => {
  test('G2048-37 五类内容非法档全部拒绝并清档', async ({ page }) => {
    test.slow();
    await open(page, '/game_2048', 1400);
    const bad = [
      ['负分', archive([2, 4], -5)],
      ['非2幂', archive([3, 3, 6, 7], 0)],
      ['全零盘', archive([], 0)],
      ['int.MaxValue', archive([2147483647, 2], 0)],
      ['伪造高分', archive([2, 4], 999999)],
    ];
    const rows = [];
    for (const [name, payload] of bad) {
      await seed(page, payload);
      const b = await readBoard(page);
      const row = {
        name,
        tiles: countTiles(b),
        values: [...new Set(b.flat().filter(Boolean))].sort((x, y) => x - y),
        score: await readScore(page),
        archive: await readSession(page),
      };
      rows.push(row);
      // 每类都必须退化成标准新局，且脏档被清掉 —— 只看"2 块"不够，新局与"恢复了 2 块档"形态相同
      expect.soft({ name: row.name, tiles: row.tiles, score: row.score, archive: row.archive },
        `[G2048-37] ${name}`).toEqual({ name, tiles: 2, score: 0, archive: null });
      check(`G2048-37-值域-${name}`, row.values.every(v => v === 2 || v === 4), `块值 ${row.values}`);
    }
    test.info().annotations.push({ type: 'G2048-37', description: JSON.stringify(rows) });
  });

  test('G2048-38 伪高分不污染 localStorage（含走一步之后）', async ({ page }) => {
    await open(page, '/game_2048', 1400);
    await seed(page, archive([2, 4], 999999));

    checkEq('G2048-38-恢复后', { best: await readBest(page), stored: await storedBest(page) },
      { best: 0, stored: null }, '伪造分不得抬升永久最高分');

    // ★ 关键：只删恢复分支的 UpdateBestScore 会在这里漏 —— Score 若仍是 999999，走一步就会把 best 写成 10 万+
    await clickDir(page, 'left');
    await sleep(600);
    const after = await storedBest(page);
    check('G2048-38-走一步后', after === null || Number(after) < 100,
      `走一步后 localStorage['${BEST_KEY}'] = ${after}（应仍为 null 或个位数）`);
  });

  test('G2048-39 合法死局档照常恢复 + 遮罩 + 禁用（FT-05 转自动化）', async ({ page }) => {
    const dead = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
    await open(page, '/game_2048', 1400);
    await seed(page, { v: 1, cells: dead, score: 24 });   // 8 个 4 ⇒ cap = 32，24 ≤ 32 才"内容合法"

    const b = await readBoard(page);
    checkEq('G2048-39-盘面',
      { tiles: countTiles(b), score: await readScore(page), archive: (await readSession(page)) !== null },
      { tiles: 16, score: 24, archive: true }, '合法死局档必须被恢复，且键保留（未被误清）');
    check('G2048-39-遮罩', (await page.locator('.game-over').count()) === 1, '死局重算后应出结束遮罩');
    const dis = await page.$$eval('.controls fluent-button',
      bs => bs.map(b => b.disabled === true || b.hasAttribute('disabled')));
    check('G2048-39-禁用', dis.length === 4 && dis.every(Boolean), `四方向按钮禁用：${JSON.stringify(dis)}`);
  });

  test('G2048-40 合法大块档恢复 + 配色类正确', async ({ page }) => {
    await open(page, '/game_2048', 1400);
    await seed(page, archive([131072, 65536, 2048, 1024], 0));   // 2 的幂边界：131072 == MaxTileValue

    const b = await readBoard(page);
    checkEq('G2048-40-盘面',
      { tiles: countTiles(b), values: [...new Set(b.flat().filter(Boolean))].sort((x, y) => y - x) },
      { tiles: 4, values: [131072, 65536, 2048, 1024] }, '最大合法块不得被拒');
    const cls = await page.$$eval('.game-container .tile', ts => ts.map(t => t.className));
    check('G2048-40-配色', cls.filter(c => c.includes('tile-super')).length === 2
      && cls.some(c => c.includes('tile-2048')) && cls.some(c => c.includes('tile-1024')),
      `配色类：${JSON.stringify([...new Set(cls)])}`);
  });

  test('G2048-41 分数上界边界：score == cap 放行、cap + 1 拒绝', async ({ page }) => {
    await open(page, '/game_2048', 1400);
    // 盘面 [4,4] 的 cap = 4·(2−1) × 2 = 8
    await seed(page, archive([4, 4], 8));
    checkEq('G2048-41-等于上界', { score: await readScore(page), archive: (await readSession(page)) !== null },
      { score: 8, archive: true }, '等于上界属"可证成立"，必须放行');

    await seed(page, archive([4, 4], 9));
    checkEq('G2048-41-超上界', { score: await readScore(page), archive: await readSession(page) },
      { score: 0, archive: null }, '比可证上界多 1 分即为不可能状态，必须拒绝并清档');
  });

  test('G2048-42 真实对局不被误杀（防"校验过紧"）', async ({ page }) => {
    test.slow();
    await open(page, '/game_2048', 1600);
    const ok = await playUntilScore(page, 100);
    const b = await readBoard(page);
    const s = await readScore(page);
    const key = await readSession(page);
    check('G2048-42-前置', ok && s >= 100 && key !== null, `走子到分数 ${s}，存档长度 ${key?.length ?? 0}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await expect.poll(async () => sig(await readBoard(page)), { timeout: 7000 }).toBe(sig(b));
    await expect.poll(() => readScore(page), { timeout: 7000 }).toBe(s);
  });
});
