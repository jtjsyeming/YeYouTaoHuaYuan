// CODE — 编程挑战；NF — 非功能（兼容/移动端/性能/并发/控制台）
// 迁移自 code_nf.mjs。NF-01 只在 firefox 项目中执行（见 playwright.config.mjs 的 testMatch）。
import { test, expect } from '@playwright/test';
import { check, open, sleep, trackErrors, viewportMetrics } from './helpers.mjs';

test.describe('CODE 编程挑战', () => {
  test('CODE-01~CODE-03 标题、纯文本题面与换行', async ({ page }) => {
    const resp = await page.goto('/coding_place', { waitUntil: 'domcontentloaded' });
    await open(page, '/coding_place', 1500);
    const h1 = ((await page.textContent('h1').catch(() => '')) || '').trim();
    const article = (await page.textContent('article').catch(() => '')) || '';
    const hasCpp = /#include|using namespace|int main\s*\(/.test(article);
    const unknownTags = await page.evaluate(() => ({
      page: document.querySelectorAll('FluentPage').length,
      header: document.querySelectorAll('FluentPageHeader').length,
      textblock: document.querySelectorAll('FluentTextBlock').length,
    }));
    const ovf = await viewportMetrics(page);

    check('CODE-01', resp && resp.status() === 200 && h1.includes('编程挑战') && article.trim().length > 50, `status=${resp && resp.status()} h1="${h1}" 正文长度=${article.trim().length}`);
    check(
      'CODE-02',
      !hasCpp && article.trim().length > 50,
      `正文含 C++ 代码特征=${hasCpp}；未知标签统计=${JSON.stringify(unknownTags)}（D-06：3 个 Fluent 标签退化为未知元素，文字仍渲染）`,
    );
    check('CODE-03', ovf.scrollW <= ovf.clientW + 1, `scrollWidth=${ovf.scrollW} clientWidth=${ovf.clientW}`);
  });
});

test.describe('NF 非功能', () => {
  test('NF-01 Firefox 兼容：5 页导航 + 三个游戏操作', async ({ page, browserName }) => {
    test.skip(browserName !== 'firefox', '仅在 firefox 项目中执行（chromium 下无意义）');
    test.setTimeout(120_000);
    const errs = trackErrors(page);
    const log = [];
    for (const [name, path] of [
      ['首页', '/'],
      ['木鱼', '/counter'],
      ['爱情计时器', '/loveTime'],
      ['2048', '/game_2048'],
      ['俄罗斯方块', '/tetris'],
    ]) {
      await open(page, path, 1200);
      const h1 = ((await page.textContent('h1').catch(() => '')) || '').trim();
      log.push(`${name}:${h1 ? 'OK' : '空'}`);
    }

    await open(page, '/counter');
    await page.locator('fluent-button.btn-primary').click();
    await sleep(400);
    const fish = ((await page.textContent('p[role=status]')) || '').trim();

    await open(page, '/game_2048');
    for (const d of ['⬅️', '⬆️', '➡️']) {
      await page.locator(`.controls fluent-button:has-text("${d}")`).click();
      await sleep(300);
    }
    const score = ((await page.textContent('p:has-text("分数")')) || '').trim();

    await open(page, '/tetris', 1600);
    await page.locator('.game-btn:has-text("←")').click();
    await page.locator('.game-btn:has-text("旋转")').click();
    await sleep(600);
    const tinfo = await page.evaluate(() => [...document.querySelectorAll('.info-value')].map(e => e.textContent.trim()));

    check(
      'NF-01',
      /次数:\s*1/.test(fish) && /分数/.test(score) && tinfo.length === 2 && errs.length === 0,
      `页面：${log.join(' ')}；木鱼="${fish}"；2048="${score}"；Tetris=${JSON.stringify(tinfo)}；JS 异常=${errs.length}（文档要求各玩 1 分钟，此处为功能抽查）`,
    );
  });

  test('NF-02 375px 触控操作（木鱼/2048/Tetris/导航折叠）', async ({ browser }) => {
    const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const mp = await mctx.newPage();
    const detail = [];

    await open(mp, '/counter');
    await mp.locator('fluent-button.btn-primary').tap();
    await sleep(400);
    const fish = ((await mp.textContent('p[role=status]')) || '').trim();
    detail.push(`木鱼 tap→${fish}`);

    await open(mp, '/game_2048');
    const before = await mp.$$eval('.tile', ts => ts.filter(t => +t.textContent.trim() > 0).length);
    await mp.locator('.controls fluent-button:has-text("⬅️")').tap();
    await sleep(400);
    const after = await mp.$$eval('.tile', ts => ts.filter(t => +t.textContent.trim() > 0).length);
    detail.push(`2048 非零块 ${before}→${after}`);

    await open(mp, '/tetris', 1600);
    const s0 = await mp.evaluate(() => parseInt([...document.querySelectorAll('.info-value')][1].textContent));
    const downBox = await mp.locator('.down-btn').boundingBox();
    await mp.touchscreen.tap(downBox.x + downBox.width / 2, downBox.y + downBox.height / 2).catch(() => {});
    await mp.locator('.game-btn:has-text("←")').tap();
    await sleep(400);
    const s1 = await mp.evaluate(() => parseInt([...document.querySelectorAll('.info-value')][1].textContent));
    detail.push(`tetris 方向键可点、分数 ${s0}→${s1}`);

    const toggler = await mp.isVisible('.navbar-toggler');
    await mp.locator('.navbar-toggler').tap();
    await sleep(400);
    const navOpen = await mp.evaluate(() => !document.querySelector('nav.flex-column').parentElement.className.includes('collapse'));
    detail.push(`折叠按钮可见=${toggler}、tap 后展开=${navOpen}`);

    await mctx.close();
    check('NF-02', /次数:\s*1/.test(fish) && after >= 2 && toggler && navOpen, detail.join('；'));
  });

  test('NF-02b 全站 6 页 375px 无横向溢出', async ({ browser }) => {
    const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const mp = await mctx.newPage();
    const pages = [
      ['首页', '/'],
      ['木鱼', '/counter'],
      ['爱情计时器', '/loveTime'],
      ['2048', '/game_2048'],
      ['俄罗斯方块', '/tetris'],
      ['编程挑战', '/coding_place'],
    ];
    const overflow = {};
    for (const [name, path] of pages) {
      await open(mp, path);
      overflow[name] = await viewportMetrics(mp);
    }
    await mctx.close();
    const bad = Object.entries(overflow).filter(([, v]) => v.scrollW > v.clientW + 1);
    check(
      'NF-02b',
      bad.length === 0,
      bad.length
        ? `溢出：${bad.map(([k, v]) => `${k}(${v.scrollW}>${v.clientW})`).join('，')}`
        : `全部无溢出（${Object.entries(overflow).map(([k, v]) => `${k}:${v.scrollW}/${v.clientW}`).join(' ')}）`,
    );
  });

  test('NF-03 Slow 3G 首屏可加载并完成 Blazor 建连', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'CDP 网络节流仅 Chromium 支持');
    const c3 = await browser.newContext();
    const p3 = await c3.newPage();
    const cdp = await c3.newCDPSession(p3);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (400 * 1024) / 8,
    });
    const t0 = Date.now();
    let ok = false;
    let ms = 0;
    try {
      const r = await p3.goto('/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      ms = Date.now() - t0;
      ok = !!r && r.status() === 200;
      await p3.waitForFunction(() => !!window.Blazor, null, { timeout: 30000 }).catch(() => {});
      ok = ok && (await p3.evaluate(() => !!window.Blazor));
    } catch {
      ms = Date.now() - t0;
      ok = false;
    }
    await c3.close();
    check('NF-03', ok, `首次加载耗时 ${ms}ms，可加载并完成建连=${ok}`);
  });

  test('NF-04 三标签并发各跑一页互不干扰', async ({ page, context }) => {
    const p2 = await context.newPage();
    const p3 = await context.newPage();
    await Promise.all([open(page, '/counter'), open(p2, '/game_2048'), open(p3, '/tetris')]);
    await page.locator('fluent-button.btn-primary').click();
    await p2.locator('.controls fluent-button:has-text("⬅️")').click();
    await p3.locator('.game-btn:has-text("旋转")').click();
    await sleep(900);
    const c = ((await page.textContent('p[role=status]')) || '').trim();
    const g = ((await p2.textContent('p:has-text("分数")')) || '').trim();
    const t = await p3.evaluate(() => [...document.querySelectorAll('.info-value')].map(e => e.textContent.trim()));
    await p2.close();
    await p3.close();
    check('NF-04', /次数:\s*1/.test(c) && /分数/.test(g) && t.length === 2, `木鱼="${c}"；2048="${g}"；Tetris 难度/分数=${JSON.stringify(t)}`);
  });

  test('NF-06 遍历 6 页控制台无红色异常', async ({ page }) => {
    const errs = trackErrors(page);
    for (const path of ['/', '/counter', '/loveTime', '/game_2048', '/tetris', '/coding_place']) {
      await open(page, path, 1200);
      await sleep(900);
    }
    check('NF-06', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : '无 console error / pageerror（含 LoveTime 每秒重渲染与 Tetris Timer 回调期）');
  });

  test('NF-05/07/08 部署与长时会话（需生产环境）', async () => {
    test.fixme(
      true,
      'NF-05（http→https 301）、NF-07（闲置 30 分钟重连）、NF-08（部署站点静态资源 200）均需 IIS/生产环境，本地开发环境无法给出确定性结论，列入发布前验收。',
    );
  });
});
