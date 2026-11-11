// D-11（浏览器标题）/ D-12（/loveTime 窄屏横向溢出）的验收断言
// 对应《09-开发文档-D11-D12缺陷修复与测试脚本固化-v2.0.md》§6
import { test } from '@playwright/test';
import { check, checkEq, open, viewportMetrics } from './helpers.mjs';

const MOBILE = { width: 375, height: 812 };

test.describe('D-11 浏览器标题', () => {
  test('D-11-1 未知路由标题为「页面不存在」，正文仍为英文提示', async ({ page }) => {
    const resp = await page.goto('/abc123', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const title = await page.title();
    const body = await page.textContent('body');
    check(
      'D-11-1',
      resp && resp.status() === 200 && title === '页面不存在' && body.includes("Sorry, there's nothing at this address."),
      `status=${resp && resp.status()} title="${title}" 含英文提示=${body.includes("Sorry, there's nothing at this address.")}`,
    );
  });

  test('D-11-2 七个路由标题与《09》§3.4 表一致（防回归）', async ({ page }) => {
    const expected = {
      '/': '夜游桃花源',
      '/counter': '按下试试',
      '/loveTime': '爱情计时器',
      '/game_2048': '2048',
      '/tetris': '俄罗斯方块',
      '/minesweeper': '扫雷',
      '/coding_place': '编程挑战',
    };
    const actual = {};
    for (const path of Object.keys(expected)) {
      await open(page, path, 900);
      actual[path] = await page.title();
    }
    checkEq('D-11-2', actual, expected);
  });

  test('D-11-3 SPA 导航过程中标题始终正确且不为空串', async ({ page }) => {
    await open(page, '/counter', 900);
    const seq = [
      ['/tetris', '俄罗斯方块', 'nav'],
      ['/counter', '按下试试', 'nav'],
      ['/loveTime', '爱情计时器', 'nav'],
      ['/game_2048', '2048', 'nav'],
    ];
    const log = [];
    let ok = true;
    for (const [path, title] of seq) {
      // 走客户端导航（点击左侧菜单），而不是整页跳转
      // 注意 NavLink 的 href 是相对路径（不含前导斜杠），见 NAV-03 实测
      await page.locator(`nav a.fluent-nav-link[href="${path.slice(1)}"]`).first().click();
      await page.waitForTimeout(1200);
      const t = await page.title();
      log.push(`${path}→"${t}"`);
      if (t !== title || t === '') ok = false;
    }
    await page.locator('nav a.fluent-nav-link[href="/"]').first().click();
    await page.waitForTimeout(1200);
    const homeTitle = await page.title();
    log.push(`/→"${homeTitle}"`);
    if (homeTitle !== '夜游桃花源') ok = false;
    check('D-11-3', ok, `SPA 导航标题序列：${log.join(' , ')}`);
  });
});

test.describe('D-12 /loveTime 窄屏适配', () => {
  test('D-12-1~D-12-3 375×812 下无横向溢出、下拉不越界、计时文本不裁切', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await open(page, '/loveTime', 1600);

    const m = await viewportMetrics(page);
    check('D-12-1', m.scrollW <= m.clientW, `documentElement scrollWidth=${m.scrollW} clientWidth=${m.clientW}（溢出 ${m.scrollW - m.clientW}px）`);

    const bars = await page.evaluate(() => {
      const bar = document.querySelector('.date-bar');
      const sels = [...document.querySelectorAll('fluent-select')];
      return {
        bar: { scrollW: bar.scrollWidth, clientW: bar.clientWidth },
        sels: sels.map(s => {
          const r = s.getBoundingClientRect();
          return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10 };
        }),
      };
    });
    check(
      'D-12-2',
      bars.bar.scrollW <= bars.bar.clientW + 1 && bars.sels.every(s => s.left >= 0),
      `.date-bar ${bars.bar.scrollW}/${bars.bar.clientW}；三个下拉 left=${bars.sels.map(s => s.left).join('/')}（负值即左边缘被切且滚不到）`,
    );

    const clips = await page.evaluate(() =>
      [...document.querySelectorAll('.timer-display')].map(el => ({
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
        h: Math.round(el.getBoundingClientRect().height * 10) / 10,
      })),
    );
    check(
      'D-12-3',
      clips.every(c => c.scrollH <= c.clientH + 1),
      `三行 scrollHeight/clientHeight=${clips.map(c => `${c.scrollH}/${c.clientH}(高${c.h})`).join(' ')}`,
    );
    await ctx.close();
  });

  test('D-12-4 六档视口逐一无横向溢出（480/481 是 v1.0 断点漏网档位）', async ({ browser }) => {
    const widths = [320, 375, 414, 480, 481, 520];
    const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const result = {};
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 812 });
      await open(page, '/loveTime', 1200);
      result[w] = await viewportMetrics(page);
    }
    await ctx.close();
    const bad = widths.filter(w => result[w].scrollW > result[w].clientW);
    check(
      'D-12-4',
      bad.length === 0,
      widths.map(w => `${w}:${result[w].scrollW}/${result[w].clientW}`).join(' ') + (bad.length ? `；溢出档位 ${bad.join(',')}` : '')
    );
  });

  test('D-12-5 521px 起回到桌面样式（inline-flex + 固定 52px 高）', async ({ page }) => {
    await page.setViewportSize({ width: 521, height: 900 });
    await open(page, '/loveTime', 1600);
    const styles = await page.evaluate(() =>
      [...document.querySelectorAll('.timer-display')].map(el => {
        const cs = getComputedStyle(el);
        return { display: cs.display, height: cs.height };
      }),
    );
    check(
      'D-12-5',
      styles.length === 3 && styles.every(s => s.display === 'inline-flex' && Math.round(parseFloat(s.height)) === 52),
      `三行样式=${JSON.stringify(styles)}（期望 display:inline-flex、height:52px）`,
    );
  });

  test('D-12-6 375px 下 /tetris 也无横向溢出（依赖《08》）', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await open(page, '/tetris', 1600);
    const m = await viewportMetrics(page);
    const cell = await page.evaluate(() => {
      const c = document.querySelector('.grid-cell');
      return c ? Math.round(c.getBoundingClientRect().width * 100) / 100 : null;
    });
    await ctx.close();
    check('D-12-6', m.scrollW <= m.clientW, `scrollWidth=${m.scrollW} clientWidth=${m.clientW}，单格宽=${cell}px（30 表示仍是旧构建/未生效）`);
  });
});
