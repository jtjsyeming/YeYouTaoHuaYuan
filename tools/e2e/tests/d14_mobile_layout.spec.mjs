// D-14：移动端俄罗斯方块「左棋盘 / 右信息 + 操作」两栏布局的验收断言
// 对应《11-开发文档-移动端俄罗斯方块右侧布局-v2.0.md》§5.1
//
// 判据说明：
//  - 横向溢出**不能**只看 documentElement.scrollWidth（D-12 时吃过亏：scrollWidth 相等但子元素被挤到容器外），
//    故 D14-1 与 D14-3/D14-5 的"子元素右边缘 ≤ clientWidth"同时存在；
//  - 文档高恒含导航 56 + .content padding-top 17.6，D14-2 依赖 --tetris-container 的 min-height 换算；
//  - 本站点由 playwright.config.mjs 的 webServer 拉起，必须带 --environment Development，否则尺寸断言全是假结果。
import { test } from '@playwright/test';
import { check, holdSoftDrop, open, readTetris, sleep, stackToGameOver, trackErrors } from './helpers.mjs';

const MOBILES = [
  { w: 320, h: 568 },
  { w: 360, h: 640 },
  { w: 375, h: 667 },
  { w: 390, h: 844 },
  { w: 414, h: 896 },
  { w: 460, h: 800 },
  { w: 520, h: 900 },
];

/** 读布局几何：画布、右栏、操作区、四个按钮与格子边长 */
const readLayout = page =>
  page.evaluate(() => {
    const doc = document.documentElement;
    const rect = el => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const f = v => Math.round(v * 10) / 10;
      return { left: f(b.left), top: f(b.top), right: f(b.right), bottom: f(b.bottom), w: f(b.width), h: f(b.height) };
    };
    const btn = t => [...document.querySelectorAll('.game-btn')].find(b => b.textContent.trim() === t);
    const cell = document.querySelector('.grid-cell');
    return {
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      scrollH: doc.scrollHeight,
      clientH: doc.clientHeight,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      vh: window.innerHeight,
      canvas: rect(document.querySelector('.game-canvas')),
      panel: rect(document.querySelector('.side-panel')),
      controls: rect(document.querySelector('.control-buttons')),
      rotate: rect(btn('旋转')),
      arrowLeft: rect(btn('←')),
      arrowDown: rect(btn('↓')),
      arrowRight: rect(btn('→')),
      topArea: rect(document.querySelector('.top-area')),
      bottomArea: rect(document.querySelector('.bottom-area')),
      cell: cell ? Math.round(cell.getBoundingClientRect().width * 100) / 100 : null,
    };
  });

test.describe('D-14 移动端俄罗斯方块右侧布局', () => {
  test('D14-1/D14-2 七档手机视口：无横向溢出、无纵向滚动', async ({ page }) => {
    test.setTimeout(150_000);
    const rows = [];
    const badW = [];
    const badH = [];
    const badKids = [];

    for (const { w, h } of MOBILES) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, '/tetris', 1500);
      const m = await readLayout(page);
      rows.push(`${w}×${h}: ${m.scrollW}/${m.clientW} × ${m.scrollH}/${m.clientH}`);

      if (m.scrollW > m.clientW) badW.push(`${w}(+${m.scrollW - m.clientW}px)`);
      // 子元素右边缘不得越过可视宽（scrollWidth 判不出来的"挤出容器"）
      if (m.panel.right > m.clientW + 0.5) badKids.push(`${w}:面板右 ${m.panel.right}>${m.clientW}`);
      if (m.controls.right > m.clientW + 0.5) badKids.push(`${w}:操作区右 ${m.controls.right}>${m.clientW}`);
      if (m.scrollH > m.clientH) badH.push(`${w}(+${m.scrollH - m.clientH}px)`);
    }

    check('D14-1', badW.length === 0 && badKids.length === 0, `横向溢出档=${badW.join(',') || '无'}；子元素越界=${badKids.join('；') || '无'}｜${rows.join(' / ')}`);
    check('D14-2', badH.length === 0, `纵向滚动档=${badH.join(',') || '无'}（min-height: calc(100dvh − 74px) 生效）｜${rows.join(' / ')}`);
  });

  test('D14-3 右栏在棋盘右侧且同排（375×667）', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await open(page, '/tetris', 1600);
    const m = await readLayout(page);
    check(
      'D14-3',
      m.panel.left >= m.canvas.right && Math.abs(m.panel.top - m.canvas.top) <= 2,
      `面板 left=${m.panel.left} ≥ 画布 right=${m.canvas.right}；面板 top=${m.panel.top} vs 画布 top=${m.canvas.top}（差 ${(m.panel.top - m.canvas.top).toFixed(1)}px，align-self:start 应≈0）`,
    );
  });

  test('D14-4/D14-5 四个操作键全部在首屏内、右栏不越界（375×667）', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await open(page, '/tetris', 1600);
    const m = await readLayout(page);
    const btns = [
      ['旋转', m.rotate],
      ['←', m.arrowLeft],
      ['↓', m.arrowDown],
      ['→', m.arrowRight],
    ];
    const outside = btns.filter(([, r]) => !r || r.bottom > m.vh || r.top < 0);
    check(
      'D14-4',
      outside.length === 0 && m.controls.left > m.canvas.right,
      `越界键=${outside.map(([t]) => t).join('/') || '无'}；按键盘底边=${btns.map(([t, r]) => `${t}:${r ? r.bottom : 'null'}`).join(' ')} ≤ 视口高 ${m.vh}；操作区 left=${m.controls.left} > 画布 right=${m.canvas.right}`,
    );
    check(
      'D14-5',
      m.panel.right <= m.clientW && m.controls.right <= m.clientW,
      `面板右 ${m.panel.right} ≤ 可视宽 ${m.clientW}；操作区右 ${m.controls.right} ≤ ${m.clientW}`,
    );
  });

  test('D14-6 状态扩展：暂停态与游戏结束态右栏仍不越出首屏（375×667）', async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 375, height: 667 });
    await open(page, '/tetris', 1600);

    // ① 暂停态：面板多一颗「已暂停 / 继续游戏」，右栏变高
    await page.locator('.game-btn:has-text("暂停游戏")').click();
    await sleep(600);
    const p = await readLayout(page);
    const paused = !!(await page.evaluate(() => !!document.querySelector('.continue-btn')));
    check(
      'D14-6-暂停',
      paused && p.panel.bottom <= p.vh && p.controls.bottom <= p.vh,
      `暂停态：面板底 ${p.panel.bottom}、操作区底 ${p.controls.bottom} ≤ 视口高 ${p.vh}（面板高 ${p.panel.h}）`,
    );

    // ② 游戏结束态：面板底部追加「游戏结束!」提示
    await page.locator('.game-btn:has-text("重新开始")').click();
    await sleep(800);
    const r = await stackToGameOver(page, 100_000);
    check('D14-6-构造', r.gameOver, r.gameOver ? `第 ${r.blocks} 块后堆满（${r.elapsed}s）` : `堆了 ${r.blocks} 块（${r.elapsed}s）仍未到顶部，无法验证结束态布局`);
    if (r.gameOver) {
      const g = await readLayout(page);
      check(
        'D14-6-结束',
        g.panel.bottom <= g.vh && g.controls.bottom <= g.vh,
        `结束态：面板底 ${g.panel.bottom}、操作区底 ${g.controls.bottom} ≤ 视口高 ${g.vh}（面板高 ${g.panel.h}）`,
      );
    }
  });

  test('D14-7 格子随视口等比收缩：375→20.5 / 320→15.0 / 520→30 封顶', async ({ page }) => {
    test.setTimeout(120_000);
    const got = {};
    for (const { w, h } of [
      { w: 320, h: 568 },
      { w: 375, h: 667 },
      { w: 520, h: 900 },
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, '/tetris', 1400);
      got[w] = (await readLayout(page)).cell;
    }
    check(
      'D14-7',
      Math.abs(got[375] - 20.5) <= 0.6 && Math.abs(got[320] - 15.0) <= 0.6 && Math.abs(got[520] - 30) < 0.01,
      `格子：320=${got[320]}px（期望 15.0±0.6）、375=${got[375]}px（期望 20.5±0.6）、520=${got[520]}px（期望 30 封顶）；算式 --cell-size: min(30px, (100vw − 170px)/10)`,
    );
  });

  test('D14-8 按钮挪位后软降事件链仍然通（375×667）', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await open(page, '/tetris', 1600);
    await page.locator('.game-btn:has-text("重新开始")').click();
    await sleep(600);
    const s0 = await readTetris(page);
    await holdSoftDrop(page, 1000);
    await sleep(500);
    const s1 = await readTetris(page);
    const gain = parseInt(s1.score) - parseInt(s0.score);
    check(
      'D14-8',
      gain >= 8 && gain <= 25,
      `按住 ↓ 1 秒得分 +${gain}（每格 +1，分数 ${s0.score}→${s1.score}）；口径同 TRIS-06`,
    );
  });

  test('D14-9 桌面零变化回归：1280 横排、700 仍堆叠', async ({ page }) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, '/tetris', 1600);
    const d = await readLayout(page);
    check(
      'D14-9-桌面',
      d.bottomArea.bottom > d.topArea.bottom && Math.abs(d.panel.top - d.canvas.top) <= 1 && d.bottomArea.w > 0,
      `1280×800：底部按钮条底 ${d.bottomArea.bottom} > 上部区底 ${d.topArea.bottom}；面板 top=${d.panel.top} 与画布 top=${d.canvas.top} 同排（差 ${(d.panel.top - d.canvas.top).toFixed(1)}px）`,
    );

    await page.setViewportSize({ width: 700, height: 900 });
    await open(page, '/tetris', 1600);
    const s = await readLayout(page);
    check(
      'D14-9-堆叠',
      s.panel.top > s.canvas.bottom,
      `700×900：面板 top=${s.panel.top} > 画布 bottom=${s.canvas.bottom}（641~780px 仍纵向堆叠）`,
    );
  });

  test('D14-10 横屏四档：棋盘与面板完整可见、操作区不超 10px、横向不回归', async ({ page }) => {
    test.setTimeout(180_000);
    // 硬断言只到「棋盘 + 面板完整可见」（用户痛点：方块落到底部看不见 / 暂停按钮滚不到）；
    // 操作区给 10px 余量：740×360 这一档的硬约束是侧栏面板高度，格子再缩也无收益（《23》§3.2 实测）。
    // 不用 scrollHeight <= innerHeight 当判据 —— 1200×400 这类桌面矮窗另有 17.6px 的 .content padding，
    // 该判据会把「min-height 配平」问题误判成「cell 公式错」。
    const LANDSCAPES = [
      { w: 844, h: 390 },
      { w: 812, h: 375 },
      { w: 740, h: 360 },
      { w: 667, h: 375 },
    ];
    const rows = [];
    const badHard = [];
    const badSoft = [];
    const badW = [];

    for (const { w, h } of LANDSCAPES) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, '/tetris', 1500);
      const m = await readLayout(page);
      const tag = `${w}×${h}`;
      rows.push(`${tag}: cell=${m.cell} 画布底=${m.canvas.bottom} 面板底=${m.panel.bottom} 控件底=${m.controls.bottom} 视口=${m.vh}`);

      if (m.canvas.bottom > m.vh + 0.5) badHard.push(`${tag} 画布底 ${m.canvas.bottom}>${m.vh}`);
      if (m.panel.bottom > m.vh + 0.5) badHard.push(`${tag} 面板底 ${m.panel.bottom}>${m.vh}`);
      if (m.controls.bottom > m.vh + 10) badSoft.push(`${tag} 控件底 ${m.controls.bottom}>${m.vh}+10`);
      if (m.scrollW > m.clientW) badW.push(`${tag} ${m.scrollW}>${m.clientW}`);
    }

    check('D14-10', badHard.length === 0, `棋盘/面板越出视口=${badHard.join('；') || '无'}｜${rows.join(' / ')}`);
    check('D14-10b', badSoft.length === 0, `操作区溢出超过 10px=${badSoft.join('；') || '无'}｜${rows.join(' / ')}`);
    check('D14-10c', badW.length === 0, `横向溢出=${badW.join('；') || '无'}`);
  });

  test('D14-10d 桌面三档回归：格子仍 30px、纵向溢出归零', async ({ page }) => {
    test.setTimeout(120_000);
    // 挂 D14-10 名下（不新占用例号）：③(100dvh−142px)/20 只在矮视口生效；
    // ④(100dvh−30px−1.1rem) 让「零纵向滚动」第一次真正为 0（原先恒溢 17.6px，P-023）。
    const DESKTOPS = [
      { w: 1400, h: 1000 },
      { w: 1280, h: 800 },
      { w: 1024, h: 768 },
    ];
    const cells = {};
    const over = {};
    for (const { w, h } of DESKTOPS) {
      await page.setViewportSize({ width: w, height: h });
      await open(page, '/tetris', 1400);
      const m = await readLayout(page);
      cells[w] = m.cell;
      over[w] = m.scrollH - m.clientH;
    }
    const badCell = Object.entries(cells).filter(([, v]) => Math.abs(v - 30) > 0.01);
    const badH = Object.entries(over).filter(([, v]) => v > 0);
    check(
      'D14-10d',
      badCell.length === 0 && badH.length === 0,
      `格子=${Object.entries(cells).map(([k, v]) => `${k}:${v}`).join(' ')}（应全为 30）；纵向溢出=${Object.entries(over).map(([k, v]) => `${k}:${v}px`).join(' ') || '无'}（应全为 0）`,
    );
  });

  test('D14-辅助 手机两栏布局下无控制台错误', async ({ page }) => {
    const errs = trackErrors(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await open(page, '/tetris', 1800);
    await holdSoftDrop(page, 600);
    await sleep(600);
    check('D14-辅助', errs.length === 0, `控制台错误 ${errs.length} 条${errs.length ? '：' + errs.slice(0, 3).join(' | ') : ''}`);
  });
});
