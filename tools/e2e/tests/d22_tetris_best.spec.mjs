// D-23：俄罗斯方块最高分持久化（localStorage `jtjsym.tetris.best`）
// 手法与 d16（2048 的 D-16）一致：预置/直读都走 localStorage，断言一律"页面文案 + 存储值"双向核对。
// 三处 Tetris 特有的坑，别照抄别的 spec：
//   ① 首屏占位是 `—`，且预渲染 HTML 里被实体化成 `&#x2014;`（P-042 同款）—— 只能拿服务端 HTML 验；
//   ② readBest 在占位期间返回 -1（元素在、正则不匹配），不是 null；
//   ③ 落盘是 fire-and-forget，点完立即读 localStorage 会拿到 null 而假红，必须 expect.poll。
import { expect, test } from '@playwright/test';
import { check, checkEq, holdSoftDrop, open, readBest, readTetris, sleep } from './helpers.mjs';

const KEY = 'jtjsym.tetris.best';

/** ⚠ addInitScript 在每次导航（含 reload）都会重跑，故**只在键不存在时**预置；
 *  无条件写会把上一局刚存下的值冲掉，让"刷新后保持"变成恒真的假绿。 */
const seedBest = (page, val) =>
  page.addInitScript(
    ([k, v]) => {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    },
    [KEY, val],
  );

const stored = page => page.evaluate(k => localStorage.getItem(k), KEY);

/** 一次 DOM 快照把 score / best / 存储值原子读完 —— 分三次读会被 50ms 一拍的软降 timer 撕开，
 *  出现 score=17 / best=16 这类假红。 */
const snapshot = page =>
  page.evaluate(k => {
    const vals = [...document.querySelectorAll('.info-value')].map(e => e.textContent.trim());
    return { difficulty: vals[0], score: parseInt(vals[1]), best: parseInt(vals[2]), ls: localStorage.getItem(k) };
  }, KEY);

test.describe('D23 俄罗斯方块最高分', () => {
  test('D22-1 读链路：预置 500 → 最高分 500、当前分 0', async ({ page }) => {
    await seedBest(page, '500');
    await open(page, '/tetris', 1500);
    const st = await readTetris(page);
    checkEq(
      'D22-1',
      { best: await readBest(page), score: st.score, cells: st.cells.length },
      { best: 500, score: '0', cells: 200 },
      '历史最高分应被读出、且不影响当前分与盘面初始化',
    );
  });

  test('D22-2 首屏占位：预渲染 HTML 里是「—」而非数字', async ({ page }) => {
    // 必须拿**服务端 HTML**：open() 默认 settle 1500ms，那时占位早就变成 0 或真实值了。
    // 用 page.goto 读 DOM 是把弱用例写成恒真（永远命中 '0'）—— 现判据对 0 直接判红。
    const resp = await page.request.get('/tetris');
    const html = await resp.text();
    const m = /class="info-row best-score"[\s\S]{0,400}?class="info-value">([^<]*)</.exec(html);
    const raw = m?.[1] ?? '(未找到 .best-score)';
    const placeholders = ['—', '&#x2014;', '&mdash;'];
    // 判"不是数字"只能用 /^\d+$/ —— 别用 !/\d/：实体 `&#x2014;` 自带 "2014"，
    // 那样写会把正确的占位判红（首版实测踩到）。
    check(
      'D22-2',
      placeholders.includes(raw) && !/^\d+$/.test(raw),
      `预渲染占位原文="${raw}"（期望 — 或实体化形式 &#x2014; / &mdash;，且不是纯数字）`,
    );
  });

  test('D22-3 无跳变：预置 999 → 占位直接变 999，期间不曾闪出 0', async ({ page }) => {
    // 16ms 采样器记录 .best-score 文本序列。双标志（isBestReading / isBestLoaded）下窗口为 0；
    // 若照抄 2048 的"await 之前就置位"，窗口内任何一次重渲染（Tetris 有 1s gameTimer + 50ms 软降 timer）
    // 都会把「—」画成「0」，弱机上必现。
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

    await open(page, '/tetris', 1500);
    await expect.poll(() => readBest(page), { timeout: 7000 }).toBe(999);
    await sleep(200); // 让采样器再记几拍，确保 999 已进序列
    const seq = await page.evaluate(() => window.__bestSeq ?? []);
    const flashedZero = seq.filter(s => s.t === '最高分:0' || s.t === '最高分：0');
    checkEq('D22-3', { flashed: flashedZero.length, ended: seq.at(-1)?.t }, { flashed: 0, ended: '最高分:999' },
      `采样序列=${JSON.stringify(seq)}（期望不出现 最高分:0，末项为 最高分:999）`);
  });

  test('D22-4 内存即时 + 未落盘：软降 1 秒 → best 跟 score，localStorage 仍空', async ({ page }) => {
    await open(page, '/tetris', 1500);
    await holdSoftDrop(page, 1000);
    await sleep(300); // 等 softDropTimer 停稳，避免读到半程分数
    const s = await snapshot(page);
    // 不写死期望分：50ms 一拍、受落块碰撞停表影响，1 秒约 16~20 分（《31》§1.3 实测 16）
    check(
      'D22-4',
      s.score > 0 && s.best === s.score && s.ls === null,
      `score=${s.score} best=${s.best} localStorage=${s.ls === null ? 'null' : JSON.stringify(s.ls)}（期望 score>0、best=score、ls 仍为 null：软降只更内存不落盘）`,
    );
  });

  test('D22-5 重玩固化：点重新开始 → 分数归零、最高分保持且已落盘', async ({ page }) => {
    await open(page, '/tetris', 1500);
    await holdSoftDrop(page, 1000);
    await sleep(300);
    const before = await readBest(page);
    check('D22-5-前置', before > 0, `重玩前最高分=${before}（软降攒分后应 > 0）`);

    await page.locator('.restart-btn').click();
    // PersistBestAsync 是 fire-and-forget：点完立即读会拿到 null。必须 poll。
    await expect.poll(() => stored(page), { timeout: 5000 }).toBe(String(before));

    const s = await snapshot(page);
    checkEq('D22-5', { score: s.score, best: s.best }, { score: 0, best: before },
      '重开不得清最高分，且重玩时已把最高分落盘（写盘排在 InitializeGame 之前）');
  });

  test('D22-6 容错：损坏值 "abc" → 最高分 0、游戏可正常起局', async ({ page }) => {
    await seedBest(page, 'abc');
    await open(page, '/tetris', 1500);
    const st = await readTetris(page);
    checkEq(
      'D22-6',
      { best: await readBest(page), cells: st.cells.length, difficulty: st.difficulty },
      { best: 0, cells: 200, difficulty: '1' },
      '损坏值按 0 处理（v > 0 才采纳），开局不受影响',
    );
  });

  test('D22-7 跨页隔离：Tetris 的最高分不被 2048 读到', async ({ page }) => {
    await seedBest(page, '500'); // 写的是 jtjsym.tetris.best
    await open(page, '/game_2048', 1600);
    const g = await readBest(page);
    check('D22-7', g === 0, `2048 的最高分=${g}（两键独立：jtjsym.tetris.best / jtjsym.g2048.best，期望 0）`);
  });
});
