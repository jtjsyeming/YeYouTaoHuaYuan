// H-014：每日一关连连看（LL-01~LL-12）
// 存储键（全部带 jtjsym. 命名空间，且都收在 LlkKeys 里）：
//   sessionStorage['jtjsym.llk.session']  = {v:1, issue, cells[48], elapsedSec}
//   localStorage['jtjsym.llk.best']      = {"issue":20261112,"sec":87}   ← 单键单条，越小越好
// ⚠ 别用 helpers.readBest：它锚的是「最高分」，对连连看恒返回 -1（扫雷那轮踩过同样的坑）。
//
// 判据纪律（沿用 C-53/54 的教训）：
//   ① 点击后一律 expect.poll 读 DOM —— Blazor Server 的 click 在服务端处理，click() resolve ≠ DOM 已更新；
//   ② 存档用 setItem + reload 注入，**不用 addInitScript**（后者每次导航都重跑，会把"玩了一半"的新档冲掉）；
//   ③ 盘面一律用 data-face 编号断言，不看图片内容（"两张图长得一样"是 e2e 的盲区，见手工清单 §7）。
import { expect, test } from '@playwright/test';
import { check, checkEq, open, sleep, trackErrors } from './helpers.mjs';

const SK = 'jtjsym.llk.session';
const BK = 'jtjsym.llk.best';
const COLS = 6;
const ROWS = 8;
const N = ROWS * COLS;

/** 期号 = 北京时间（UTC+8）的 yyyyMMdd，与 LianliankanCore.IssueFor 同口径。 */
const todayIssue = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return Number(d.toISOString().slice(0, 10).replace(/-/g, ''));
};

const idx = (r, c) => r * COLS + c;

/** 48 格的头像编号（0 = 空）。DOM 顺序就是 idx 顺序。 */
const readCells = page =>
  page.$$eval('.llk-cell', els => els.map(e => {
    const v = e.getAttribute('data-face');
    return v === null ? 0 : Number(v);
  }));

const readElapsed = page =>
  page.evaluate(() => {
    const m = (document.querySelector('.llk-elapsed')?.textContent ?? '').match(/(\d+)/);
    return m ? Number(m[1]) : -1;
  });

const readBestText = page =>
  page.evaluate(() => (document.querySelector('.llk-best')?.textContent ?? '').trim());

const readBestStored = page => page.evaluate(k => localStorage.getItem(k), BK);

const storedSec = raw => {
  try {
    return JSON.parse(raw).sec;
  } catch {
    return null;
  }
};

const sessionRaw = page => page.evaluate(k => sessionStorage.getItem(k), SK);

/** 注入一份会话档并 reload（reload 后 sessionStorage 仍在，正是"切页/刷新回来"的真实路径）。 */
const seedSession = async (page, { cells, elapsed = 5, issue = todayIssue() }) => {
  const payload = JSON.stringify({ v: 1, issue, cells, elapsedSec: elapsed });
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [SK, payload]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(1100);
};

const setBest = (page, value) =>
  page.evaluate(([k, v]) => localStorage.setItem(k, v), [BK, value]);

/** 造一份只剩指定块的盘（其余全 0）。 */
const cellsWith = entries => {
  const cells = new Array(N).fill(0);
  for (const [i, face] of entries) cells[i] = face;
  return cells;
};

const clickCell = async (page, i) => {
  await page.locator(`.llk-cell[data-idx="${i}"]`).click();
  await sleep(220);            // 一次 SignalR 往返；真正的判据仍用 poll
};

test.describe('LL 连连看', () => {
  test('LL-01 首屏：48 格、24 张脸各两张、标题期号、sprite 200、预渲染已含盘面', async ({ page, request }) => {
    // ① 预渲染 HTML（服务端确定性铺盘 ⇒ 首包就该有 48 格与格位变量）
    const html = await (await request.get('/lianliankan')).text();
    const cellCount = (html.match(/class="llk-cell/g) || []).length;
    const colVars = (html.match(/--c:/g) || []).length;
    const rowVars = (html.match(/--r:/g) || []).length;
    check('LL-01-预渲染', cellCount === N && colVars === N && rowVars === N,
      `HTML 中 llk-cell=${cellCount}、--c=${colVars}、--r=${rowVars}（应各 ${N}）`);

    await open(page, '/lianliankan', 1600);

    const cells = await readCells(page);
    const counts = {};
    for (const v of cells) counts[v] = (counts[v] ?? 0) + 1;
    const faces = Object.keys(counts).map(Number).filter(v => v > 0);
    const paired = faces.length === 24 && faces.every(f => counts[f] === 2);

    check('LL-01-格数', cells.length === N && cells.every(v => v === 0 || (v >= 1 && v <= 24)),
      `格数=${cells.length}；值域=[${Math.min(...cells)}, ${Math.max(...cells)}]`);
    check('LL-01-成对', paired, `不同头像=${faces.length} 张，每种张数=${JSON.stringify(counts)}`);

    const h1 = ((await page.textContent('h1').catch(() => '')) || '').trim();
    check('LL-01-期号', h1 === `地球日${todayIssue()}关`, `标题="${h1}"（应「地球日${todayIssue()}关」）`);
    check('LL-01-计时', (await readElapsed(page)) === 0, `用时=${await readElapsed(page)}`);

    // sprite 必须真的能取到（图挂了 CSS 会退回米纸底，肉眼像"格子还没加载完"）
    const sprite = await request.get('/Images/llk/faces.png');
    check('LL-01-图', sprite.status() === 200, `sprite status=${sprite.status()}`);
  });

  test('LL-02 每日确定性：同日两份盘逐格相同；昨日的档被期号闸丢弃', async ({ page }) => {
    await open(page, '/lianliankan', 1600);
    const first = await readCells(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await sleep(1300);
    const second = await readCells(page);

    checkEq('LL-02-确定性', second, first);

    // 期号闸：昨天（这里用 20260101 代表"别的某一天"）的档必须整档丢弃，且不留恢复提示
    await seedSession(page, { cells: cellsWith([[0, 1], [1, 1]]), elapsed: 9, issue: 20260101 });
    const elapsed = await readElapsed(page);
    const tip = await page.locator('.llk-resume-tip').count();
    check('LL-02-期号闸', elapsed === 0 && tip === 0, `用时=${elapsed} 恢复提示=${tip} 个`);
    check('LL-02-清档', (await sessionRaw(page)) === null, `sessionStorage=${await sessionRaw(page)}`);
  });

  test('LL-03 消除链路：点两张可连的同号 → 两格清空', async ({ page }) => {
    await open(page, '/lianliankan', 1600);

    // (0,0)/(0,1) 紧邻的「1」，另留一对「2」在底行，避免消除后变成空盘（空盘会走胜局分支）
    await seedSession(page, { cells: cellsWith([[idx(0, 0), 1], [idx(0, 1), 1], [idx(7, 4), 2], [idx(7, 5), 2]]) });

    await clickCell(page, idx(0, 0));
    await clickCell(page, idx(0, 1));

    await expect.poll(() => readCells(page).then(c => c[idx(0, 0)] + c[idx(0, 1)]), { timeout: 7000 }).toBe(0);
    const cells = await readCells(page);
    checkEq('LL-03', { a: cells[idx(0, 0)], b: cells[idx(0, 1)], rest: cells.filter(v => v > 0).length },
      { a: 0, b: 0, rest: 2 });
  });

  test('LL-04 不可连不消除：两张同号被另一对夹住 → 点了都还在', async ({ page }) => {
    await open(page, '/lianliankan', 1600);

    // 2×2 棋盘格死局（(3,2)=1,(4,3)=1 被 (3,3)=2,(4,2)=2 夹住）；
    // 另在 (0,0)/(0,1) 放一对「3」让盘上仍有可连对 —— 否则恢复时会触发自动重排，把死局救活
    await seedSession(page, {
      cells: cellsWith([
        [idx(0, 0), 3], [idx(0, 1), 3],
        [idx(3, 2), 1], [idx(4, 3), 1],
        [idx(3, 3), 2], [idx(4, 2), 2],
      ]),
    });

    const tip = await page.locator('.llk-reshuffle-tip').count();
    check('LL-04-前置', tip === 0, `不该触发自动重排（触发=${tip} 个）`);

    await clickCell(page, idx(3, 2));
    await clickCell(page, idx(4, 3));
    await sleep(600);

    const cells = await readCells(page);
    checkEq('LL-04', { a: cells[idx(3, 2)], b: cells[idx(4, 3)] }, { a: 1, b: 1 });
  });

  test('LL-05 死局自动重排：恢复死局档不丢弃、出飘字、多重集不变且重新可消', async ({ page }) => {
    await open(page, '/lianliankan', 1600);

    // 只留 4 块且互为死局（棋盘格）
    await seedSession(page, {
      cells: cellsWith([
        [idx(3, 2), 1], [idx(4, 3), 1],
        [idx(3, 3), 2], [idx(4, 2), 2],
      ]),
      elapsed: 7,
    });

    const before = (await readCells(page)).filter(v => v > 0).sort((a, b) => a - b);
    checkEq('LL-05-不丢弃', before, [1, 1, 2, 2]);

    const tipText = (await page.textContent('.llk-reshuffle-tip').catch(() => ''))?.trim() ?? '';
    check('LL-05-飘字', tipText === '无解自动重排', `飘字="${tipText}"`);
    check('LL-05-暂停', (await readElapsed(page)) === 7, `恢复即暂停，用时=${await readElapsed(page)}（应 7）`);

    // 重排后必须存在可连对：按头像逐个试，只要有一次真的消掉了就说明"重新可消"
    let eliminated = false;
    const after = await readCells(page);
    const faces = [...new Set(after.filter(v => v > 0))];
    for (const face of faces) {
      const spots = after.map((v, i) => (v === face ? i : -1)).filter(i => i >= 0);
      if (spots.length < 2) continue;
      await clickCell(page, spots[0]);
      await clickCell(page, spots[1]);
      const now = await readCells(page);
      if (now.filter(v => v > 0).length < after.filter(v => v > 0).length) {
        eliminated = true;
        break;
      }
    }
    check('LL-05-可消', eliminated, `重排后两两试过 ${faces.length} 个头像都没消掉（说明仍是死局）`);
  });

  test('LL-06 胜局：消完最后一对 → 遮罩显示用时、会话被清', async ({ page }) => {
    await open(page, '/lianliankan', 1600);
    await seedSession(page, { cells: cellsWith([[idx(0, 0), 5], [idx(0, 1), 5]]), elapsed: 5 });

    await clickCell(page, idx(0, 0));
    await clickCell(page, idx(0, 1));

    await expect.poll(() => page.locator('.llk-overlay').count(), { timeout: 7000 }).toBe(1);
    const sub = ((await page.textContent('.llk-overlay-sub')) || '').trim();
    const elapsed = await readElapsed(page);
    check('LL-06', /用时 \d+ 秒/.test(sub) && elapsed >= 1, `遮罩="${sub}" 用时=${elapsed}`);
    await expect.poll(() => sessionRaw(page), { timeout: 5000 }).toBeNull();
  });

  test('LL-07 纪录口径：更快才刷新、相等不覆盖、跨天坏值显示「—」', async ({ page }) => {
    const issue = todayIssue();
    await open(page, '/lianliankan', 1600);

    const playOnce = async () => {
      await seedSession(page, { cells: cellsWith([[idx(0, 0), 5], [idx(0, 1), 5]]), elapsed: 5 });
      await clickCell(page, idx(0, 0));
      await clickCell(page, idx(0, 1));
      await expect.poll(() => page.locator('.llk-overlay').count(), { timeout: 7000 }).toBe(1);
    };

    // ① 预置一条很慢的纪录 → 通关后应变小
    await setBest(page, JSON.stringify({ issue, sec: 999 }));
    await playOnce();
    await expect.poll(() => readBestStored(page), { timeout: 6000 }).not.toBe(null);
    const first = storedSec(await readBestStored(page));
    check('LL-07-刷新', first !== null && first < 999, `999 → ${first}`);

    // ② 预置 1 秒（打不破）→ 通关后仍是 1
    await setBest(page, JSON.stringify({ issue, sec: 1 }));
    await playOnce();
    const second = storedSec(await readBestStored(page));
    checkEq('LL-07-不覆盖', second, 1);

    // ③ 跨天残留 → 显示「—」且能正常开局
    await setBest(page, JSON.stringify({ issue: 20260101, sec: 9 }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await sleep(1300);
    check('LL-07-跨天', (await readBestText(page)).includes('—'), `榜文案="${await readBestText(page)}"`);
    check('LL-07-可玩', (await readCells(page)).filter(v => v > 0).length === N, `盘上块数=${(await readCells(page)).filter(v => v > 0).length}`);

    // ④ 坏值 → 同样「—」，且不影响开局
    await setBest(page, 'abc');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await sleep(1300);
    check('LL-07-坏值', (await readBestText(page)).includes('—'), `榜文案="${await readBestText(page)}"`);
  });

  test('LL-08 会话保持：切页回来盘面一致、暂停态、点一格才续走', async ({ page }) => {
    await open(page, '/lianliankan', 1600);
    await seedSession(page, {
      cells: cellsWith([[idx(0, 0), 1], [idx(0, 1), 1], [idx(7, 4), 2], [idx(7, 5), 2]]),
      elapsed: 4,
    });

    // 先消掉一对，制造"玩过一半"的残局
    await clickCell(page, idx(0, 0));
    await clickCell(page, idx(0, 1));
    await expect.poll(() => readCells(page).then(c => c[idx(0, 0)]), { timeout: 7000 }).toBe(0);
    const before = await readCells(page);

    // ⚠ 别用 reload：sessionStorage 刷新后仍在，切页才是"复用真实路径"
    await open(page, '/', 900);
    await open(page, '/lianliankan', 1400);

    const after = await readCells(page);
    checkEq('LL-08-盘面', after, before);
    check('LL-08-提示', (await page.locator('.llk-resume-tip').count()) === 1, '恢复提示未出现');

    const paused = await readElapsed(page);
    await sleep(1600);
    check('LL-08-暂停', (await readElapsed(page)) === paused, `暂停态用时 ${paused}s → ${await readElapsed(page)}s（应不变）`);

    const live = (await readCells(page)).findIndex(v => v > 0);
    await clickCell(page, live);
    await expect.poll(() => readElapsed(page), { timeout: 6000 }).toBeGreaterThan(paused);
    check('LL-08-续走', (await readElapsed(page)) > paused, `点一格后用时=${await readElapsed(page)}s（应 > ${paused}）`);
  });

  test('LL-09 切后台不涨时：注入 visibilityState=hidden → 2 秒后用时不变', async ({ page }) => {
    await open(page, '/lianliankan', 1600);
    await seedSession(page, { cells: cellsWith([[idx(0, 0), 1], [idx(0, 1), 1], [idx(7, 4), 2], [idx(7, 5), 2]]), elapsed: 2 });

    // 先点一格把表走起来（单击只选中，不消除）
    await clickCell(page, idx(0, 0));
    await expect.poll(() => readElapsed(page), { timeout: 6000 }).toBeGreaterThan(2);
    const running = await readElapsed(page);

    // headless 下 bringToFront 不产生 hidden，只能改属性 + 手工派发事件
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await sleep(700);                          // 让 150ms 延迟派发 + 一次 render 落地
    const paused = await readElapsed(page);
    await sleep(1800);
    const later = await readElapsed(page);
    check('LL-09', later === paused, `隐藏后 ${paused}s → ${later}s（应不变；隐藏前在走=${running}s）`);
  });

  test('LL-10 窄屏横向：375 / 320 无横向溢出', async ({ browser }) => {
    const bad = [];
    for (const vp of [{ width: 375, height: 812 }, { width: 320, height: 568 }]) {
      const ctx = await browser.newContext({ viewport: vp, isMobile: true, hasTouch: true });
      const mp = await ctx.newPage();
      await open(mp, '/lianliankan', 1400);
      const m = await mp.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      if (m.scrollW > m.clientW + 1) bad.push(`${vp.width}px: ${m.scrollW} > ${m.clientW}`);
      await ctx.close();
    }
    check('LL-10', bad.length === 0, bad.length ? bad.join(' | ') : '375/320 均无横向溢出');
  });

  test('LL-11 窄屏纵向：320×568 不出现纵向滚动（紧凑档的看守）', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    const mp = await ctx.newPage();
    await open(mp, '/lianliankan', 1400);

    const m = await mp.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
      boardH: Math.round(document.querySelector('.llk-board')?.getBoundingClientRect().height ?? 0),
      boardW: Math.round(document.querySelector('.llk-board')?.getBoundingClientRect().width ?? 0),
    }));
    await ctx.close();

    check('LL-11', m.scrollH <= m.clientH, `scrollHeight=${m.scrollH} clientHeight=${m.clientH}（棋盘 ${m.boardW}×${m.boardH}）`);
  });

  test('LL-12 资产完整：24 张脸全上、24 个格位互不重复', async ({ page }) => {
    await open(page, '/lianliankan', 1600);

    const info = await page.$$eval('.llk-cell', els => els.map(e => ({
      face: e.getAttribute('data-face'),
      pos: e.getAttribute('style'),
    })));

    const faces = [...new Set(info.map(x => Number(x.face)).filter(v => v >= 1))].sort((a, b) => a - b);
    checkEq('LL-12-全脸', faces, Array.from({ length: 24 }, (_, i) => i + 1));

    // 每种头像只该出现在一个 sprite 格位上：24 个不同的 (--c,--r) 组合
    const byFace = new Map();
    for (const x of info) {
      if (!x.face) continue;
      byFace.set(Number(x.face), x.pos);
    }
    const positions = [...byFace.values()];
    check('LL-12-格位', positions.length === 24 && new Set(positions).size === 24,
      `24 张脸对应 ${new Set(positions).size} 个不同的格位；示例=${JSON.stringify(positions.slice(0, 3))}`);
  });
});
