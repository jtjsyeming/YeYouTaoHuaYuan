// D-16：2048 最高分持久化（localStorage `jtjsym.g2048.best`）
// D-35 / P-040 起另加两条"占位不被首帧渲染成 0"（G2048-48 / G2048-49），见文件末尾组注释。
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

  // ─────────── D-35 / P-040：最高分占位不再被首帧渲染成 0（G2048-48 / G2048-49） ───────────
  // 修复是**两处**：① 模板加 `isBestLoaded` 占位判断；② C# 里 `isBestLoaded = true` 挪到 await 之后。
  // 删任一处都会露 0，但两处**可观测性不同**，这一点是实测出来的、不是推的（《46》§3.2 说反了）：
  //   · 只回退 ①（模板）⇒ 编译期就报 **CS0414（isBestLoaded 赋值但从未读取）**，两条用例同时红。
  //   · 只回退 ②（时序）⇒ **两条都绿**（2026-11-16 镜像红检实测）。因为 2048 **没有周期定时器**
  //     （"gameTimer 每秒一拍"是 Tetris 的特性，2048 代码里 `grep gameTimer` 只命中注释），
  //     且 ① 执行期间 `isRestoring` 还是 true、全部按钮 disabled ⇒ await 窗口内**不存在任何服务端重渲染**。
  //     没有重渲染，两版输出逐字节相同 ⇒ ② 的错序在 2048 上不可观测（在 Tetris 上可观测：D22-3 用 1s timer 撞）。
  //   ⇒ G2048-49 守的是"整条冷启动序列（预渲染 HTML → 水合 → 首帧）不出现 最高分：0"，
  //     **不宣称**它守住 ② 的顺序。② 的顺序由《46》§8 #1 的源码 grep 判据兜（赋值必须在 await 之后）。
  //
  // ⚠ 别照抄 D22-2：Tetris 是两层结构（info-row → info-value），这条正则是给一层结构写的。
  //    2048 的 `<p class="best-score">` 直接包文本，`([^<]*)` 取到的是 **`最高分：&#x2014;`**，
  //    不等于占位集合里任何一项 ⇒ 照抄首跑即红。
  test('G2048-48 首屏占位：预渲染 HTML 里是「—」而非数字', async ({ page }) => {
    // 必须拿**服务端 HTML**：open() 有 1600ms settle，那时占位早已解锁成 0 或真实值，
    // 读 DOM 等于把弱用例写成恒真。
    const resp = await page.request.get('/game_2048');
    const html = await resp.text();
    const m = /class="best-score">([^<]*)</.exec(html);
    const raw = m?.[1] ?? '(未找到 .best-score)';
    const v = raw.includes('：') ? raw.split('：').pop().trim() : raw;   // 去掉「最高分：」前缀
    const placeholders = ['—', '&#x2014;', '&mdash;'];
    // 判"不是数字"只能用 /^\d+$/ —— 别用 !/\d/：实体 `&#x2014;` 自带 "2014"。
    check(
      'G2048-48',
      placeholders.includes(v) && !/^\d+$/.test(v),
      `预渲染占位="${raw}"（切分后="${v}"，期望 — 或实体化形式，且不是纯数字）`,
    );
  });

  test('G2048-49 无跳变：预置 999 → 占位直接变 999，期间不曾闪出 0', async ({ page }) => {
    // 16ms 采样器记录 .best-score 文本序列，覆盖"预渲染 HTML → 水合 → 首帧"整段。
    // 它能抓的是"模板没做占位"这条路径（首帧就是 0）；**抓不到** ② 的错序（见组注释里的镜像红检结论）。
    await page.addInitScript(
      ([k, v]) => {
        if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
        window.__bestSeq = [];
        const t0 = performance.now();
        const timer = setInterval(() => {
          const el = document.querySelector('.best-score');
          const t = (el ? el.textContent.trim() : '(none)').replace(/\s+/g, '');
          const seq = window.__bestSeq;
          if (!seq.length || seq[seq.length - 1].t !== t) seq.push({ t, ms: Math.round(performance.now() - t0) });
          if (performance.now() - t0 > 6000) clearInterval(timer);
        }, 16);
      },
      [KEY, '999'],
    );

    await open(page, '/game_2048', 1600);
    await expect.poll(() => readBest(page), { timeout: 7000 }).toBe(999);
    await sleep(200); // 让采样器再记几拍，确保 999 已进序列
    const seq = await page.evaluate(() => window.__bestSeq ?? []);
    // 2048 的文案是全角冒号（`最高分：`），Tetris 是半角 —— 两种都认，避免将来改标点假红。
    const flashedZero = seq.filter(s => s.t === '最高分:0' || s.t === '最高分：0');
    checkEq('G2048-49', { flashed: flashedZero.length, ended: seq.at(-1)?.t }, { flashed: 0, ended: '最高分：999' },
      `采样序列=${JSON.stringify(seq)}（期望不出现 最高分:0，末项为 最高分：999）`);
  });
});
