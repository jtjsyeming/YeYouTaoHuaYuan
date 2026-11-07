// D-03：爱情计时器日历精确换算（年/月/天）
// 手法同 G2048-STEP：Node 侧独立实现同一套规则（AddYears/AddMonths 的 clamp），
// 对多个锚点反算期望文案，再与页面副行逐条比对 —— 这样闰日/月末这些边界才真正被覆盖。
// 已知残余（不影响门禁）：页面在点击瞬间用 DateTime.Now 算、期望值在 sleep(450) 之后现算，
// 故 23:59:59.6 附近执行可能因跨零点误报 1 天；DST 时区（本机为 CST 无 DST）切换日同理。
import { test } from '@playwright/test';
import { check, checkEq, open, pickSelect, sleep, viewportMetrics } from './helpers.mjs';

// ── 独立实现（不调 .NET，按文档 §2.1/§3.2 的规则重写）──
const clampAddMonths = (d, n) => {
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const first = new Date(y, m, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), lastDay));
};
const clampAddYears = (d, n) => clampAddMonths(d, n * 12);

/**
 * 期望值必须与产品同口径：LoveTime.razor:227 的 (now - t2).Days 是 TimeSpan 的**向零截断**（正数即 floor），
 * 而 Test/functiontest.mjs:125 的独立实现也是 floor。
 * 禁止改回 Math.round —— now 含时分秒，本地 12:00 之后 round 必然进位，会让 LT-26/27/28 上午绿、下午红（P-001）。
 * 冻结时刻自检见 LT-28 末尾的「口径」check。
 */
function ymd(anchor, now) {
  const a = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  if (now < a) return { y: 0, m: 0, d: 0 };
  let y = now.getFullYear() - a.getFullYear();
  let t = clampAddYears(a, y);
  if (t > now) { y -= 1; t = clampAddYears(a, y); }
  let m = (now.getFullYear() - t.getFullYear()) * 12 + now.getMonth() - t.getMonth();
  let t2 = clampAddMonths(t, m);
  if (t2 > now) { m -= 1; t2 = clampAddMonths(t, m); }
  return { y, m, d: Math.floor((now - t2) / 86400000) };
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

    // 口径自检（P-001 回归护栏）：同一锚点、同一天的两个时刻，天数必须相等。
    // 若有人把 floor 改回 round，19:00 会得 +1 天 → 这条立刻红，不需要等到下午才发现。
    const anchor = new Date(2018, 3, 22);
    const morning = ymd(anchor, new Date(2026, 10, 6, 9, 0, 0)).d;
    const evening = ymd(anchor, new Date(2026, 10, 6, 19, 0, 0)).d;
    check('LT-28-口径', morning === evening, `同一天 09:00 与 19:00 的天数必须相等：${morning} vs ${evening}（相等=截断口径，差 1=有人改回了 round）`);
  });

  test('LT-29 秒级刷新下副行恒定（年月天不随秒抖动）', async ({ page }) => {
    await open(page, '/loveTime', 1600);
    const a = (await subLines(page).nth(0).textContent())?.trim();
    await sleep(3000);
    const b = (await subLines(page).nth(0).textContent())?.trim();
    checkEq('LT-29', b, a, `3 秒后副行仍为「${a}」`);
  });

  test('LT-30 375px / 320px：副行不引入横向溢出，主行与副行均不裁切', async ({ browser }) => {
    const rows = [];
    for (const vp of [{ width: 375, height: 667 }, { width: 320, height: 568 }]) {
      const ctx = await browser.newContext({ viewport: vp, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await open(page, '/loveTime', 1400);
      const m = await viewportMetrics(page);
      const clip = await page.evaluate(() => ({
        main: [...document.querySelectorAll('.timer-display')].map(el => el.scrollHeight <= el.clientHeight + 1).every(Boolean),
        cal: [...document.querySelectorAll('.timer-calendar')]
          .map(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1).every(Boolean),
        calCount: document.querySelectorAll('.timer-calendar').length,
      }));
      rows.push({ w: vp.width, sw: m.scrollW, cw: m.clientW, ...clip });
      await ctx.close();
    }
    const bad = rows.filter(r => r.sw > r.cw || !r.main || !r.cal || r.calCount !== 3);
    check('LT-30', bad.length === 0,
      `${rows.map(r => `${r.w}px:${r.sw}/${r.cw} 主行=${r.main} 副行=${r.cal}(${r.calCount})`).join(' / ')}`);
  });
});
