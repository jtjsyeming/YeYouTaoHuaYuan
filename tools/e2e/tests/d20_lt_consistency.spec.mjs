// P-010 / P-014：爱情计时器事件回调后的渲染一致性
// 核心手法：相位对齐。ticker 每秒一次，但相位 φ（tick 相对整秒的偏移）由"页面开始交互的那一瞬"决定，
// 每次加载都不同；能观测到 P-010 的窗口宽度恰好等于 φ。故先量 φ、φ 太小就重新加载换相位，
// 再在"整秒边界之后、下一次 tick 之前"点击 —— 这样"被点行走新秒、另两行还在旧秒"是必然事件，不是概率事件。
import { test } from '@playwright/test';
import { check, open, pickSelect, readLoveTime, sleep } from './helpers.mjs';

const MIN_PHI = 250;   // 低于这个值，点击+采样的往返会吃掉整个窗口

/** 观察一次秒刷，返回该次 tick 时刻的 Date.now()（毫秒）；5s 内没有变化返回 null */
const observeTick = page =>
  page.evaluate(
    () =>
      new Promise(resolve => {
        const el = document.querySelectorAll('div.timer')[0];
        const obs = new MutationObserver(() => {
          obs.disconnect();
          resolve(Date.now());
        });
        obs.observe(el, { childList: true, characterData: true, subtree: true });
        setTimeout(() => {
          obs.disconnect();
          resolve(null);
        }, 5000);
      }),
  );

/** 取一次 φ ≥ MIN_PHI 的加载（每次 goto 都是新电路、新相位） */
async function loadWithGoodPhase(page) {
  for (let i = 0; i < 6; i++) {
    await open(page, '/loveTime', 2200);
    const t = await observeTick(page);
    if (t !== null && t % 1000 >= MIN_PHI) return t % 1000;
  }
  return null;
}

const readSecs = page =>
  page.evaluate(() =>
    [...document.querySelectorAll('div.timer')].map(t => {
      const m = /(\d+)\s*秒/.exec(t.textContent);
      return m ? +m[1] : null;
    }),
  );

test('LT-31 事件回调：三行秒数必须同步进入新秒（相位对齐，确定性）', async ({ page }) => {
  const phi = await loadWithGoodPhase(page);
  check('LT-31-相位', phi !== null, `ticker 相位 φ=${phi}ms（需 ≥ ${MIN_PHI}，6 次加载仍未取到即判红）`);
  if (phi === null) return;

  // 等到"下一个整秒边界 + 40ms"
  const nowMs = await page.evaluate(() => Date.now());
  const boundary = Math.floor(nowMs / 1000) * 1000 + 1000;
  await sleep(Math.max(0, boundary + 40 - nowMs));

  // 点击（用 DOM click 而非 locator.click：省掉 hit-test，时序更准）
  await page.evaluate(() => document.querySelectorAll('.love-reset-bar fluent-button')[0].click());

  // 在下一次 tick（boundary+φ）之前反复采样：不一致会一直保持到那次 tick，轮询比单点稳
  const deadline = boundary + phi - 40;
  let last = null;
  let bad = null;
  while (Date.now() < deadline) {
    last = await readSecs(page);
    if (new Set(last).size > 1) {
      bad = last;
      break;
    }
    await sleep(20);
  }

  check(
    'LT-31',
    bad === null,
    `φ=${phi}ms，整秒边界后 40ms 点击 → 三行秒数 ${(bad ?? last ?? []).join('/')}` +
      `（未修复时必为 "k/k-1/k-1"，k 为被点行）`,
  );
});

test('LT-32 秒级重渲染不破坏年份/日期下拉（P-014 相邻性质）', async ({ page }) => {
  await open(page, '/loveTime', 2000);
  await pickSelect(page, 0, '2020');
  await pickSelect(page, 1, '2');
  await pickSelect(page, 2, '29');   // 2020-02 有 29 天
  const before = await readLoveTime(page);
  const expectYears = new Date().getFullYear() - 1950 + 1;

  await sleep(3200);                 // 让 RefreshAll/EnsureYearsFresh 跑满 3 个 tick
  const after = await readLoveTime(page);

  check(
    'LT-32-年份',
    after.yearCount === expectYears && after.y === '2020',
    `年份选项 ${after.yearCount} 项（期望 ${expectYears}），已选=${after.y}`,
  );
  check(
    'LT-32-日期',
    after.dayOptions.length === 29 && after.d === '29',
    `日期选项 ${after.dayOptions.length} 项（2020-02 应为 29），已选=${after.d}`,
  );
  check(
    'LT-32-稳定',
    before.y === after.y && before.m === after.m && before.d === after.d,
    `3 个 tick 前后选择应不变：${before.y}-${before.m}-${before.d} → ${after.y}-${after.m}-${after.d}`,
  );
});
