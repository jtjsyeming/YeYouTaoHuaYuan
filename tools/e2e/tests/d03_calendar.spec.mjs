// D-03：爱情计时器日历精确换算（年/月/天）
// 手法同 G2048-STEP：Node 侧独立实现同一套规则（AddYears/AddMonths 的 clamp），
// 对多个锚点反算期望文案，再与页面副行逐条比对 —— 这样闰日/月末这些边界才真正被覆盖。
import { test } from '@playwright/test';
import { check, checkEq, open, pickSelect, sleep, viewportMetrics } from './helpers.mjs';

const MOBILE = { width: 375, height: 667 };

// ── 独立实现（不调 .NET，按文档 §2.1/§3.2 的规则重写）──
const clampAddMonths = (d, n) => {
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const first = new Date(y, m, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), lastDay));
};
const clampAddYears = (d, n) => clampAddMonths(d, n * 12);

function ymd(anchor, now) {
  const a = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  if (now < a) return { y: 0, m: 0, d: 0 };
  let y = now.getFullYear() - a.getFullYear();
  let t = clampAddYears(a, y);
  if (t > now) { y -= 1; t = clampAddYears(a, y); }
  let m = (now.getFullYear() - t.getFullYear()) * 12 + now.getMonth() - t.getMonth();
  let t2 = clampAddMonths(t, m);
  if (t2 > now) { m -= 1; t2 = clampAddMonths(t, m); }
  return { y, m, d: Math.round((now - t2) / 86400000) };
}

function expectText({ y, m, d }) {
  if (y === 0 && m === 0 && d === 0) return '不到 1 天';
  const seg = [];
  if (y > 0) seg.push(`${y} 年`);
  if (m > 0) seg.push(`${m} 个月`);
  if (d > 0) seg.push(`${d} 天`);
  if (y > 0 && m === 0 && d === 0) seg[seg.length - 1] = `${y} 年整`;
  return seg.join(' ');
}

const day = n => new Date(n.getFullYear(), n.getMonth(), n.getDate());
const today = day(new Date());
const shift = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// ── 页面操作 ──
const subLines = page => page.locator('.timer-calendar');

async function applyAnchor(page, d, btnIndex = 0) {
  await pickSelect(page, 0, String(d.getFullYear()));
  await pickSelect(page, 1, String(d.getMonth() + 1));
  await pickSelect(page, 2, String(d.getDate()));
  await page.locator('fluent-button.timer').nth(btnIndex).click();
  await sleep(450);
  return (await subLines(page).nth(btnIndex).textContent())?.trim() ?? '';
}

test.describe('D03 爱情计时器日历年月天', () => {
  test('LT-25 三行都有副行，且三行格式一致可解析', async ({ page }) => {
    await open(page, '/loveTime', 1600);
    const texts = await subLines(page).allTextContents();
    check(
      'LT-25',
      texts.length === 3 &&
        texts.every(t => /(\d+ 年整|\d+ 年|\d+ 个月|\d+ 天|不到 1 天)/.test(t.trim())),
      `三行副行=${JSON.stringify(texts.map(t => t.trim()))}`,
    );
    // 主行一字未动（LT-01 的 3 个 div.timer 仍在）
    const n = await page.locator('div.timer').count();
    checkEq('LT-25-主行未变', n, 3, 'div.timer 仍为 3 个（副行没有复用到 .timer）');
  });

  test('LT-26 相对今天的三个锚点（今天 / 昨天 / 7 天前）', async ({ page }) => {
    test.slow();
    await open(page, '/loveTime', 1600);
    for (const [d, label] of [[today, '今天'], [shift(today, -1), '昨天'], [shift(today, -7), '7 天前']]) {
      const got = await applyAnchor(page, d);
      const want = expectText(ymd(d, new Date()));
      checkEq(`LT-26-${label}`, got, want, `锚点 ${d.toDateString()} 应为「${want}」`);
    }
  });

  test('LT-27 闰日与月末锚点（clamp 语义）', async ({ page }) => {
    test.slow();
    await open(page, '/loveTime', 1600);
    for (const [d, label] of [
      [new Date(2020, 1, 29), '2020-02-29 闰日'],
      [new Date(2023, 0, 31), '2023-01-31 月末'],
    ]) {
      const got = await applyAnchor(page, d);
      const want = expectText(ymd(d, new Date()));
      checkEq(`LT-27-${label}`, got, want, `锚点 ${d.toDateString()} 应为「${want}」`);
    }
  });

  test('LT-28 内置相识日：副行与主行天数自洽', async ({ page }) => {
    await open(page, '/loveTime', 1600);
    const got = (await subLines(page).nth(0).textContent())?.trim() ?? '';
    const want = expectText(ymd(new Date(2018, 3, 22), new Date()));
    checkEq('LT-28', got, want, `内置 2018-04-22 应为「${want}」（与主行首段天数同源）`);
  });

  test('LT-29 秒级刷新下副行恒定（年月天不随秒抖动）', async ({ page }) => {
    await open(page, '/loveTime', 1600);
    const a = (await subLines(page).nth(0).textContent())?.trim();
    await sleep(3000);
    const b = (await subLines(page).nth(0).textContent())?.trim();
    checkEq('LT-29', b, a, `3 秒后副行仍为「${a}」`);
  });

  test('LT-30 375px：副行不引入横向溢出，且主行仍不裁切', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await open(page, '/loveTime', 1400);
    const m = await viewportMetrics(page);
    const clip = await page.evaluate(() =>
      [...document.querySelectorAll('.timer-display')].map(el => el.scrollHeight <= el.clientHeight + 1).every(Boolean),
    );
    check('LT-30', m.scrollW <= m.clientW && clip, `375px：${m.scrollW}/${m.clientW}；三行主行不裁切=${clip}`);
    await ctx.close();
  });
});
