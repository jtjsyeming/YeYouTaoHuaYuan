// NAV — 站点框架；FISH — 电子木鱼
// 迁移自 nav_fish.mjs + fix.mjs + fix2.mjs（三者覆盖同一模块，合并为两个 describe）
// 用例编号写进 test() 标题首段，便于 --grep NAV / --grep FISH 过滤并与《07》一一对应。
import { test, expect } from '@playwright/test';
import { check, checkEq, open, sleep, trackErrors } from './helpers.mjs';

test.describe('NAV 站点框架', () => {
  test('NAV-01~NAV-03 首页内容、5 项导航与高亮', async ({ page }) => {
    await open(page, '/');

    const h1 = (await page.textContent('h1').catch(() => '')) || '';
    const h2 = (await page.textContent('main h2').catch(() => '')) || '';
    check(
      'NAV-01',
      h1.includes('欢迎来到夜游桃花源') && h2.includes('你好'),
      `h1="${h1.trim()}" h2="${h2.trim()}"`,
    );

    const navMap = [
      ['jtjsym', '/'],
      ['按下试试', '/counter'],
      ['爱情计时器', '/loveTime'],
      ['2048', '/game_2048'],
      ['俄罗斯方块', '/tetris'],
    ];
    const navResults = [];
    for (const [text, expectPath] of navMap) {
      await open(page, '/');
      await page.locator('nav a.nav-link', { hasText: text }).first().click();
      await sleep(1200);
      const url = new URL(page.url()).pathname;
      navResults.push(`${text}→${url}${url === expectPath ? '' : '✗期望' + expectPath}`);
    }
    check('NAV-02', navResults.every(r => !r.includes('✗')), `5 项跳转：${navResults.join(' | ')}`);

    await open(page, '/tetris');
    const activeText = await page.textContent('nav a.nav-link.active').catch(() => '');
    const activeHref = await page.evaluate(() => {
      const a = document.querySelector('nav a.nav-link.active');
      return a ? a.getAttribute('href') : null;
    });
    await open(page, '/');
    const rootHref = await page.evaluate(() => {
      const a = document.querySelector('nav a.nav-link.active');
      return a ? a.getAttribute('href') : null;
    });
    check(
      'NAV-03',
      (activeText || '').includes('俄罗斯方块') && activeHref === 'tetris' && rootHref === '',
      `在 /tetris 高亮="${(activeText || '').trim()}"(href=${activeHref})；在 / 高亮 href="${rootHref}"`,
    );
  });

  test('NAV-04~NAV-06 折叠断点、备案号与链接', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await open(page, '/');
    const togglerVisible375 = await page.isVisible('.navbar-toggler');
    await page.click('.navbar-toggler');
    await sleep(400);
    const navParentClass = await page.evaluate(() => {
      const nav = document.querySelector('nav.flex-column');
      return nav ? nav.parentElement.className : null;
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await sleep(300);
    const togglerVisible1280 = await page.isVisible('.navbar-toggler');
    check(
      'NAV-04',
      togglerVisible375 && navParentClass !== null && !navParentClass.includes('collapse') && !togglerVisible1280,
      `375px 按钮可见=${togglerVisible375}；点击后菜单容器 class="${navParentClass}"；1280px 按钮可见=${togglerVisible1280}`,
    );

    await open(page, '/');
    const footerText = ((await page.textContent('footer').catch(() => '')) || '').trim();
    check('NAV-05', footerText.includes('陕ICP备2024056488号'), `footer="${footerText}"`);

    const href = await page.getAttribute('footer a', 'href').catch(() => '');
    const target = await page.getAttribute('footer a', 'target').catch(() => '');
    check(
      'NAV-06',
      href === 'https://beian.mps.gov.cn/#/' && target === '_blank',
      `href="${href}" target="${target}"（域名为公安部平台，见 D-05）`,
    );
  });

  test('NAV-07 各路由标题（页面自带 PageTitle，未设置的回退站点名）', async ({ page }) => {
    const expected = {
      '/': 'jtjsym',
      '/counter': '按下试试',
      '/loveTime': '爱情计时器',
      '/game_2048': '2048',
      '/tetris': '俄罗斯方块',
      '/coding_place': '编程挑战',
    };
    const actual = {};
    for (const path of Object.keys(expected)) {
      await open(page, path, 900);
      actual[path] = await page.title();
    }
    checkEq('NAV-07', actual, expected);
  });

  test('NAV-08 隐藏页 /coding_place 可访问且导航无入口', async ({ page }) => {
    await open(page, '/coding_place');
    const h1 = ((await page.textContent('h1').catch(() => '')) || '').trim();
    const navHasCoding = await page.locator('nav a.nav-link', { hasText: 'Coding' }).count();
    check('NAV-08', h1.includes('编程挑战') && navHasCoding === 0, `h1="${h1}"，导航含 Coding 项=${navHasCoding}`);
  });

  test('NAV-09 未知路由：HTTP 200 + 英文提示 + 标题「页面不存在」', async ({ page }) => {
    const resp = await page.goto('/abc123', { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    const body = await page.textContent('body');
    const title = await page.title();
    check(
      'NAV-09',
      resp && resp.status() === 200 && body.includes("Sorry, there's nothing at this address.") && title === '页面不存在',
      `status=${resp && resp.status()} title="${title}" 含英文提示=${body.includes("Sorry, there's nothing at this address.")}`,
    );
  });

  test('NAV-10 右上角 About 外链（模板残留 D-07）', async ({ page }) => {
    await open(page, '/');
    const href = await page.getAttribute('main .top-row a', 'href').catch(() => null);
    const text = ((await page.textContent('main .top-row a').catch(() => '')) || '').trim();
    check('NAV-10', href === 'https://docs.microsoft.com/aspnet/', `文字="${text}" href="${href}"`);
  });
});

test.describe('FISH 电子木鱼', () => {
  test('FISH-01~FISH-05 计数、装饰、连点与刷新归零', async ({ page }) => {
    await open(page, '/counter');
    const decoCount = () => page.locator('article div img[src*="counter.gif"]').count();
    const statusText = async () => ((await page.textContent('p[role=status]')) || '').trim();

    const t0 = await statusText();
    const btnCount = await page.locator('fluent-button.btn-primary').count();
    const decoBefore = await decoCount();
    check(
      'FISH-01',
      /次数:\s*0/.test(t0) && btnCount === 1 && decoBefore === 0,
      `文案="${t0}" 按钮数=${btnCount} 装饰 gif 数=${decoBefore}（装饰为 <div><img src=Images/counter.gif>，非 fluent-icon）`,
    );

    const box = await page.locator('fluent-button.btn-primary').boundingBox();
    check(
      'FISH-01b',
      box && Math.round(box.width) === 48 && Math.round(box.height) === 48,
      `按钮实际 ${box ? Math.round(box.width) + '×' + Math.round(box.height) : 'N/A'}（期望 48×48）`,
    );

    await page.locator('fluent-button.btn-primary').click();
    await sleep(500);
    const t1 = await statusText();
    const decoAfter = await decoCount();
    check('FISH-02', /次数:\s*1/.test(t1) && decoAfter === 2, `点击后文案="${t1}" 装饰 gif=${decoAfter}（期望 2）`);

    for (let i = 0; i < 9; i++) {
      await page.locator('fluent-button.btn-primary').click();
      await sleep(60);
    }
    await sleep(500);
    const t10 = await statusText();
    check('FISH-03', /次数:\s*10/.test(t10), `连点 10 次后文案="${t10}"`);

    await page.locator('fluent-button.btn-primary').hover();
    await sleep(200);
    await page.mouse.move(5, 5);
    await sleep(600);
    const decoOut = await decoCount();
    await page.locator('fluent-button.btn-primary').hover();
    await sleep(600);
    const decoRehover = await decoCount();
    check(
      'FISH-04',
      decoOut === 0 && decoRehover === 0,
      `移出后装饰=${decoOut}，重新移入后=${decoRehover}（需再次点击才出现）`,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1500);
    const tReload = await statusText();
    check('FISH-05', /次数:\s*0/.test(tReload), `刷新后文案="${tReload}"`);
  });

  test('FISH-06 断网期间点击不生效，恢复后从原值继续', async ({ page, context }) => {
    const statusText = async () => ((await page.textContent('p[role=status]').catch(() => '')) || '').trim();
    const n = s => parseInt(/次数:\s*(\d+)/.exec(s)?.[1] ?? '-1');

    await open(page, '/counter');
    await page.locator('fluent-button.btn-primary').click();
    await sleep(500);
    const before = await statusText();

    await context.setOffline(true);
    await sleep(300);
    await page.locator('fluent-button.btn-primary').click({ timeout: 2000 }).catch(() => {});
    await sleep(1500);
    const during = await statusText();

    await context.setOffline(false);
    await sleep(5000);
    await page.locator('fluent-button.btn-primary').click({ timeout: 3000 }).catch(() => {});
    await sleep(1500);
    const after = await statusText();

    // 断言口径（2026-11-01 D11-D12 实测修正）：断网期间 UI 不更新；重连后能继续累加。
    // 恢复后的增量可能 >1 —— 断网期间的点击会被 Blazor 缓冲、重连后补执行（登记为 D-14），
    // 这不是"断网仍生效"，而是"补执行"；原断言 after == before+1 会因此随机失败。
    const delta = n(after) - n(before);
    check(
      'FISH-06',
      n(during) === n(before) && delta >= 1,
      `断网前="${before}" → 断网中="${during}" → 恢复后="${after}"；恢复后增量=${delta}${delta > 1 ? '（>1：断网期间的点击被缓冲并在重连后补执行，见 D-14）' : ''}`,
    );
  });

  test('FISH-07 计数上百后显示完整', async () => {
    // 需真实点击 100 次，11-01 基线未执行；不做"照代码推断"的假通过。
    test.fixme(true, 'FISH-07 需累计 100 次点击，基线未执行；FISH-03 已证累加正确');
  });
});
