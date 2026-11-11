// D15 — 首页卡片化与 Fluent 组件统一（《12-开发文档-首页卡片化与Fluent组件统一-v2.0.md》§7.1）
import { test } from '@playwright/test';
import { check, holdSoftDrop, open, readBoard, readScore, readTetris, sleep, trackErrors } from './helpers.mjs';

const MOBILE = { width: 375, height: 667 };
const DESKTOP = { width: 1280, height: 900 };

test.describe('D15 首页卡片化与 Fluent 统一', () => {
  test('D15-1/D15-2 首页 6 张卡片与 5 个跳转 href', async ({ page }) => {
    await open(page, '/', 1200);
    const h1 = ((await page.textContent('h1').catch(() => '')) || '').trim();
    const hrefs = await page.$$eval('main a.home-card', as => as.map(a => a.getAttribute('href')));
    check('D15-1', h1.includes('欢迎来到夜游桃花源') && (await page.locator('.home-card').count()) === 6, `h1="${h1}"；.home-card=${await page.locator('.home-card').count()}`);
    check(
      'D15-2',
      JSON.stringify(hrefs) === JSON.stringify(['counter', 'loveTime', 'game_2048', 'tetris', 'minesweeper']),
      `链接卡 href=${JSON.stringify(hrefs)}`,
    );
  });

  test('D15-3 卡片走 SPA 跳转（不整页刷新）', async ({ page }) => {
    await open(page, '/', 1200);
    await page.evaluate(() => { window.__d15mark = 'alive'; });
    await page.locator('a.home-card', { hasText: '俄罗斯方块' }).first().click();
    await sleep(1400);
    const path = new URL(page.url()).pathname;
    const mark = await page.evaluate(() => window.__d15mark || null);
    check('D15-3', path === '/tetris' && mark === 'alive', `跳转到 ${path}；点击前打的 window 标记=${mark}（仍在=未整页刷新）`);
  });

  test('D15-4/D15-5/D15-6 标题、页脚定位与备案链接', async ({ page }) => {
    test.setTimeout(90_000);
    const rows = [];
    let okPos = true;
    for (const vp of [MOBILE, DESKTOP]) {
      await page.setViewportSize(vp);
      await open(page, '/', 1200);
      const m = await page.evaluate(() => {
        const f = document.querySelector('footer');
        const r = f.getBoundingClientRect();
        return {
          position: getComputedStyle(f).position,
          right: Math.round(r.right * 10) / 10,
          left: Math.round(r.left * 10) / 10,
          clientW: document.documentElement.clientWidth,
        };
      });
      rows.push(`${vp.width}: position=${m.position} footer ${m.left}~${m.right} ≤ ${m.clientW}`);
      if (m.position === 'fixed' || m.right > m.clientW + 0.5) okPos = false;
    }
    check('D15-5', okPos, rows.join(' | '));

    const title = await page.title();
    check('D15-4', title === '夜游桃花源', `document.title="${title}"`);

    const href = await page.getAttribute('footer a', 'href').catch(() => '');
    const target = await page.getAttribute('footer a', 'target').catch(() => '');
    check('D15-6', href === 'https://beian.miit.gov.cn/' && target === '_blank', `href="${href}" target="${target}"`);
  });

  test('D15-7/D15-8 375px 单列不溢出、1280px 多列同排', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(MOBILE);
    await open(page, '/', 1200);
    const mob = await page.evaluate(() => {
      const cs = [...document.querySelectorAll('.home-card')].map(c => c.getBoundingClientRect());
      return {
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        widths: cs.map(r => Math.round(r.width * 10) / 10),
        overflow: cs.filter(r => r.right > document.documentElement.clientWidth + 0.5).length,
        tops: cs.map(r => Math.round(r.top)),
      };
    });
    const spread = Math.max(...mob.widths) - Math.min(...mob.widths);
    check(
      'D15-7',
      mob.sw === mob.cw && spread <= 1 && mob.overflow === 0,
      `scrollWidth/clientWidth=${mob.sw}/${mob.cw}；卡片宽=${mob.widths.join('/')}（极差 ${spread.toFixed(1)}px）；越界卡片=${mob.overflow}`,
    );

    await page.setViewportSize(DESKTOP);
    await open(page, '/', 1200);
    const desk = await page.evaluate(() => {
      // 简介卡横跨整行（banner），首排只剩它一张，故此断言取 4 张跳转卡
      const tops = [...document.querySelectorAll('main a.home-card')].map(c => Math.round(c.getBoundingClientRect().top));
      const first = tops[0];
      return { tops, sameRow: tops.filter(t => Math.abs(t - first) <= 1).length };
    });
    check('D15-8', desk.sameRow >= 3, `1280px 跳转卡 top=${desk.tops.join('/')}，与首张同排 ${desk.sameRow} 张`);
  });

  test('D15-9/D15-10 Tetris 按钮已迁 FluentButton（::part 生效、禁用态 0.5）', async ({ page }) => {
    test.setTimeout(120_000);
    const errs = trackErrors(page);
    await page.setViewportSize(DESKTOP);
    await open(page, '/tetris', 1800);

    const info = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.game-btn')];
      const one = btns.find(b => b.className.includes('direction-btn'));
      const inner = one?.shadowRoot?.querySelector('.control');
      return {
        count: btns.length,
        tags: [...new Set(btns.map(b => b.tagName))],
        innerBg: inner ? getComputedStyle(inner).backgroundColor : null,
        innerPad: inner ? getComputedStyle(inner).padding : null,
        hostBg: one ? getComputedStyle(one).backgroundColor : null,
      };
    });
    check(
      'D15-9',
      info.count === 6 && info.tags.length === 1 && info.tags[0] === 'FLUENT-BUTTON' && info.innerBg === 'rgba(0, 0, 0, 0)',
      `.game-btn=${info.count} 标签=${info.tags.join('/')}；内部 .control 背景=${info.innerBg}（透明=::part 生效、颜色由宿主给）、padding=${info.innerPad}、宿主背景=${info.hostBg}`,
    );

    await page.locator('.game-btn:has-text("暂停游戏")').click();
    await sleep(700);
    const dis = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.game-btn')].find(x => x.textContent.trim() === '已暂停');
      if (!b) return null;
      return {
        has: b.hasAttribute('disabled'),
        opacity: getComputedStyle(b).opacity,
        innerOpacity: b.shadowRoot ? getComputedStyle(b.shadowRoot.querySelector('.control')).opacity : null,
      };
    });
    check(
      'D15-10',
      !!dis && dis.has && dis.opacity === '0.5',
      dis ? `「已暂停」hasAttribute(disabled)=${dis.has}，宿主 opacity=${dis.opacity}（期望 0.5），内部 .control opacity=${dis.innerOpacity}` : '未找到「已暂停」按钮',
    );
    check('D15-10-控制台', errs.length === 0, `控制台错误 ${errs.length} 条${errs.length ? '：' + errs.slice(0, 2).join(' | ') : ''}`);
  });

  test('D15-11 /coding_place 用 FluentCard 且保留 h1', async ({ page }) => {
    await open(page, '/coding_place', 1500);
    const h1 = ((await page.textContent('h1').catch(() => '')) || '').trim();
    const cards = await page.locator('fluent-card').count();
    const body = ((await page.textContent('body')) || '').trim();
    check('D15-11', h1.includes('编程挑战') && cards >= 1 && body.includes('任务混部'), `h1="${h1}"；fluent-card=${cards}；含「任务混部」=${body.includes('任务混部')}`);
  });

  test('D15-12 2048 四个方向键已迁 FluentButton 且仍可走棋', async ({ page }) => {
    await open(page, '/game_2048', 1600);
    const counts = await page.evaluate(() => ({
      dir: document.querySelectorAll('.dir-btn').length,
      replay: document.querySelectorAll('.replay-btn').length,
      tags: [...new Set([...document.querySelectorAll('.dir-btn')].map(b => b.tagName))],
    }));
    check(
      'D15-12-结构',
      counts.dir === 4 && counts.replay === 1 && counts.tags[0] === 'FLUENT-BUTTON',
      `.dir-btn=${counts.dir}、.replay-btn=${counts.replay}、标签=${counts.tags.join('/')}`,
    );

    const b0 = await readBoard(page);
    const s0 = await readScore(page);
    await page.locator('.controls fluent-button:has-text("⬅️")').click();
    await sleep(420);
    const b1 = await readBoard(page);
    const s1 = await readScore(page);
    const moved = JSON.stringify(b0) !== JSON.stringify(b1);
    check('D15-12-走棋', moved || s1 !== s0, `点 ⬅️ 后棋盘${moved ? '变化' : '未变'}、分数 ${s0}→${s1}（FluentButton 的 @onclick 已落到宿主元素）`);

    // 顺带确认指针事件链没被 Shadow DOM 吞掉：按住 ↓ 900ms 后 Tetris 分数应上升（软降每格 +1）
    await open(page, '/tetris', 1600);
    const t0 = parseInt((await readTetris(page)).score);
    await holdSoftDrop(page, 900);
    await sleep(400);
    const t1 = parseInt((await readTetris(page)).score);
    check('D15-12-指针事件', t1 > t0, `按住 ↓ 900ms 后 Tetris 分数 ${t0}→${t1}（软降指针事件未被 Shadow DOM 吞掉）`);
  });
});
