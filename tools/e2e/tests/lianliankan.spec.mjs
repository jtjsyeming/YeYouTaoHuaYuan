// H-014 / H-015 / D-31：每日一关连连看（LL-01~LL-22）
// 存储键（全部带 jtjsym. 命名空间，且都收在 LlkKeys 里）：
//   sessionStorage['jtjsym.llk.session']  = {v:1, issue, cells[48], elapsedSec}
//   localStorage['jtjsym.llk.best']      = {"issue":20261112,"sec":87}   ← 单键单条，越小越好
// ⚠ 别用 helpers.readBest：它锚的是「最高分」，对连连看恒返回 -1（扫雷那轮踩过同样的坑）。
//
// 判据纪律（沿用 C-53/54 的教训）：
//   ① 点击后一律 expect.poll 读 DOM —— Blazor Server 的 click 在服务端处理，click() resolve ≠ DOM 已更新；
//   ② 存档用 setItem + reload 注入，**不用 addInitScript**（后者每次导航都重跑，会把"玩了一半"的新档冲掉）；
//   ③ 盘面一律用 data-face 编号断言，不看图片内容（"两张图长得一样"是 e2e 的盲区，见手工清单 §7）；
//   ④ **凡是 seedSession 造盘，每种头像的张数必须是偶数** —— LianliankanCore.TryFrom 的成对闸
//      会整档丢弃奇数档，页面静默回落"真实每日盘"，用例照样绿但点的不是你以为的格子。
//      症状指纹：seedSession 传了 elapsed: 5，页面读到的却是「用时：0 秒」、也没有恢复提示。
//      造盘一律"两个头像各两张"，别写"两格不同脸"（1+1 是奇数）。这条比"重排"那条更隐蔽 ——
//      重排会让盘面变、至少看得出来；成对闸是整档替换成一张合法的每日盘，看起来一切正常。
//   ⑤ **要点格子的用例必须用 openLlk，不能用 open**（H-015 起）：首访玩法遮罩 inset:0 会盖住棋盘，
//      Playwright 每个 test 都是新 context ⇒ localStorage 恒空 ⇒ 遮罩必弹 ⇒ click 直接 3.5s 超时。
//      openLlk 预置 "已看过" 再 reload。⚠ 别用 addInitScript（每次导航都重跑，会把 LL-15 冲掉）。
//   ⑥ **重排动画（D-31）的窗口只有 220ms，判据有三条硬约束**：
//      a) "出现"必须单独成一步。单用 poll(busy 属性 === 0) 是无效锚点 —— 点击后 SignalR 往返期
//         属性还没加上，poll 立刻返回、后续断言在动画里跑（零余量，D22-5 同款）。
//      b) intervals 必须收紧。默认 [100,250,500,1000] 在 220ms 窗口上只剩 1~2 次采样。
//      c) 抓"恢复即重排"时**不能走 seedSession**：它自带 sleep(1100)，远大于 470ms 全程，
//         poll 到时动画早演完了。那条用例只能裸注入 + reload 后立刻 poll。
//      另：第二击之后**不能**用 clickCell（它内含 sleep 220 = 整个淡出窗口），必须裸 click。
import { expect, test } from '@playwright/test';
import { check, checkEq, open, openLlk, sleep, trackErrors } from './helpers.mjs';

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

/** 失败反馈（D-30）的文案。节点不存在时返回空串 —— 直接 textContent('.llk-click-tip') 会抛。 */
const readClickTip = page =>
  page.evaluate(() => (document.querySelector('.llk-click-tip')?.textContent ?? '').trim());

/** 正在抖的格子（DOM 顺序 = idx 顺序）。 */
const shakeIdx = page =>
  page.$$eval('.llk-cell.is-shake', els => els.map(e => Number(e.getAttribute('data-idx'))));

/**
 * 连接线的 DOM 快照。没有 SVG 时返回 null —— 直接读属性会抛。
 * 三个挂点见 wwwroot/js/llkline.js：svg.llk-line-svg / polyline[data-llk-mode] / circle[data-llk-bend]。
 */
const readLineSvg = page =>
  page.evaluate(() => {
    const svg = document.querySelector('svg.llk-line-svg');
    if (!svg) return null;
    const line = svg.querySelector('polyline[data-llk-mode]');
    const box = svg.getBoundingClientRect();
    return {
      mode: line ? line.getAttribute('data-llk-mode') : '',
      raw: line ? line.getAttribute('points') : '',
      bends: svg.querySelectorAll('circle[data-llk-bend]').length,
      w: Math.round(box.width),
      h: Math.round(box.height),
    };
  });

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

/**
 * 重排动画（D-31）的紧凑采样窗口：out 阶段只有 220ms，默认 intervals 剩不下几次机会。
 * 首次给 10ms —— 恢复场景下 waitForFunction(Blazor) 返回时距动画启动只有几十毫秒。
 */
const TIGHT = { intervals: [10, 25, 25, 50, 100, 200], timeout: 5000 };

const shuffleOutCount = page => page.locator('.llk-cell.is-shuffle-out').count();
const shuffleInCount = page => page.locator('.llk-cell.is-shuffle-in').count();
const busyCount = page => page.locator('.llk-board[data-llk-reshuffling]').count();

/**
 * 试着消掉任意一对同脸 —— 重排后的盘面取决于 Reshuffle 的确定性实现，用例不该假设它长什么样。
 * 试错一次后必须把"选中"取消掉（失败时选中已挪到第二格，再点一次即取消），
 * 否则下一对的第一击会落到"换选中"分支、把盘面读歪。
 */
const eliminateAnyPair = async page => {
  const cells = await readCells(page);
  const before = cells.filter(v => v > 0).length;
  const faces = [...new Set(cells.filter(v => v > 0))];

  for (const face of faces) {
    const spots = cells.map((v, i) => (v === face ? i : -1)).filter(i => i >= 0);
    if (spots.length < 2) continue;

    await clickCell(page, spots[0]);
    await clickCell(page, spots[1]);

    if ((await readCells(page)).filter(v => v > 0).length < before) return true;
    await clickCell(page, spots[1]);         // 没消掉：取消残留选中
  }

  return false;
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
    await openLlk(page);

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
    await openLlk(page);

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
    await openLlk(page);

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
    await openLlk(page);
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
    await openLlk(page);

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
    await openLlk(page);
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
    await openLlk(page);
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

  test('LL-13 点错有反馈：两张不同脸 → 提示带两个角色名 + 抖动，1.6s 后自动消失', async ({ page, browser }) => {
    await openLlk(page);

    // ⚠ 盘必须过成对闸（LianliankanCore.TryFrom：每种头像的剩余数须为偶数）：1、2 各两张。
    //   只放"两张不同脸"（1 张 + 1 张）会被整档丢弃、页面回落真实每日盘 —— 用例照样能绿，
    //   但点的不是你钉住的格子，明天换期号就可能点到两张同脸。LL-04 那句注释讲的是"重排"，这是另一个闸。
    //   四点两两不相邻、只共享盘边绕行 ⇒ HasAnyPair() 为真，不触发自动重排。
    await seedSession(page, {
      cells: cellsWith([
        [idx(0, 0), 1], [idx(0, 1), 2],
        [idx(7, 4), 1], [idx(7, 5), 2],
      ]),
      elapsed: 5,
    });

    // 前置：档真被接受了。「用时 5 秒」是没被丢弃的指纹 —— 干净的每日盘恒为 0 秒。
    check('LL-13-前置', (await readElapsed(page)) === 5, `用时=${await readElapsed(page)}（5=档已恢复；0=被成对闸丢弃、回落每日盘）`);

    // 角色名从 aria-label 反查，不写死中文：换角色（LianliankanThemes）时这条断言不用跟着改，
    // 顺带交叉校验了「提示里的名字」与「格子自己的无障碍名」是同一套。
    const nameA = await page.getAttribute(`.llk-cell[data-idx="${idx(0, 0)}"]`, 'aria-label');
    const nameB = await page.getAttribute(`.llk-cell[data-idx="${idx(0, 1)}"]`, 'aria-label');

    await clickCell(page, idx(0, 0));
    await clickCell(page, idx(0, 1));

    await expect.poll(() => readClickTip(page), { timeout: 4000 }).toContain('图案不同');
    const tip = await readClickTip(page);
    check('LL-13-文案', tip.includes(nameA) && tip.includes(nameB), `提示="${tip}"，两格是「${nameA}」「${nameB}」`);

    const cells = await readCells(page);
    const filled = cells.filter(v => v > 0).length;
    // ⚠ 别照抄《38》里的「is-gone 数为 0」：那张判据是按满盘（48 块）写的，而这张盘只有 4 块，
    //   另外 44 格**本来就**是 is-gone（空格）。这里要的是"这两格没被消除"：data-face 还在、块数仍是 4。
    check('LL-13-未消除', cells[idx(0, 0)] === 1 && cells[idx(0, 1)] === 2 && filled === 4,
      `两格=${cells[idx(0, 0)]}/${cells[idx(0, 1)]}，剩余块数=${filled}（应 4；少一块就是被消了）`);

    // 抖动：class 活满 1.6s（CSS 动画只播 300ms）⇒ click() + sleep(220) 有 1.4s 余量抓它
    await expect.poll(() => shakeIdx(page), { timeout: 3000 }).toEqual([idx(0, 0), idx(0, 1)]);
    checkEq('LL-13-抖动', await shakeIdx(page), [idx(0, 0), idx(0, 1)]);

    // 1.6s 后自动清（本站第一个"会自己消失"的提示，没有现成模式可抄）
    await expect.poll(() => readClickTip(page), { timeout: 4000 }).toBe('');
    const tipNodes = await page.locator('.llk-click-tip').count();
    check('LL-13-自清', tipNodes === 0, `1.6s 后提示节点数=${tipNodes}，文案="${await readClickTip(page)}"`);

    // 320×568：反馈行出现时不能把页面顶出纵向滚动。
    // LL-11 打开的是干净页面、永远看不见这一行，所以这条必须在这里补 —— 提示槽的纵向预算只有 58px。
    const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    const mp = await ctx.newPage();
    await openLlk(mp, 1400);
    await seedSession(mp, {
      cells: cellsWith([
        [idx(0, 0), 1], [idx(0, 1), 2],
        [idx(7, 4), 1], [idx(7, 5), 2],
      ]),
      elapsed: 5,
    });
    await clickCell(mp, idx(0, 0));
    await clickCell(mp, idx(0, 1));
    await expect.poll(() => mp.locator('.llk-click-tip').count(), { timeout: 4000 }).toBe(1);
    const m = await mp.evaluate(() => {
      const t = document.querySelector('.llk-click-tip');
      const r = t ? t.getBoundingClientRect() : null;
      return {
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight,
        tipH: Math.round(r?.height ?? 0),
        tipW: Math.round(r?.width ?? 0),
      };
    });
    await ctx.close();
    check('LL-13-窄屏', m.scrollH <= m.clientH,
      `320 下 scrollHeight=${m.scrollH} clientHeight=${m.clientH}，提示行 ${m.tipW}×${m.tipH}（高度 > 21 说明折行了）`);
  });

  test('LL-14 同脸不可连：③ 层虚线 + 「最多拐两次弯」且不消除；紧接着消掉一对 → 提示同时收掉', async ({ page }) => {
    await openLlk(page);

    // 造盘计数：1 号 ×4、2 号 ×2、3 号 ×2 —— 全偶数，过成对闸。
    //   (3,2)/(4,3) 同脸 1，被 (3,3)/(4,2) 的 2 夹住 ⇒ 只能绕，2 拐内没有通路（同 LL-04 的死局几何）
    //   (0,0)/(0,1) 一对 1：既让 1 号凑成 4 张，又是第 3 步"成功后提示必须收掉"要消的那一对
    //   (7,4)/(7,5) 兜底一对：第 3 步消完盘上仍有一对 ⇒ 不跳「无解自动重排」，
    //               少了这对，第 3 步会让 showReshuffleTip 变真、提示槽被重排文案占据，"提示变空"必假红
    await seedSession(page, {
      cells: cellsWith([
        [idx(0, 0), 1], [idx(0, 1), 1],
        [idx(3, 2), 1], [idx(4, 3), 1],
        [idx(3, 3), 2], [idx(4, 2), 2],
        [idx(7, 4), 3], [idx(7, 5), 3],
      ]),
    });

    const blocks = (await readCells(page)).filter(v => v > 0).length;
    const reshuffle0 = await page.locator('.llk-reshuffle-tip').count();
    check('LL-14-前置', blocks === 8 && reshuffle0 === 0, `块数=${blocks}（应 8）重排提示=${reshuffle0} 个（应 0）`);

    // ① 同脸但 2 拐内拐不过去
    await clickCell(page, idx(3, 2));
    await clickCell(page, idx(4, 3));
    // ⚠ 整句匹配：④ 层的「这两张连不上」也含「连不上」，包含匹配分不出 ③/④。
    //   H-015 起这两种几何走的是不同分支（③ 画虚线解释"拐数不够"、④ 只抖），
    //   这里断言的是 ③ 那句带解释的文案。
    await expect.poll(() => readClickTip(page), { timeout: 4000 }).toBe('连不上：最多拐两次弯');
    const cells1 = await readCells(page);
    check('LL-14-未消除', cells1[idx(3, 2)] === 1 && cells1[idx(4, 3)] === 1,
      `两格=${cells1[idx(3, 2)]}/${cells1[idx(4, 3)]}（应都还是 1）`);

    // H-015 起这张盘落在 **③ 层**（有路、但要 3 拐），不再是"抖动"那一层：
    //   (3,2) 下方被 (4,2) 堵住、右方被 (3,3) 堵住 ⇒ 只能绕外圈，
    //   实测 3 拐 [(3,2)→(2,2)→(2,0)…] 这类路存在 ⇒ 画虚线 + 不抖。
    //   D-30 时代它断言的是「抖这两格」，那是"没有分层"时的行为，**判据必须跟着改**，
    //   否则等于把"③ 也抖"钉成契约（那会让 ③ 同时给"线"和"震"两个相反信号）。
    checkEq('LL-14-不抖', await shakeIdx(page), []);
    const line14 = await readLineSvg(page);
    check('LL-14-虚线', line14?.mode === 'hint', `data-llk-mode="${line14?.mode}"（③ 层应画 hint 虚线）`);

    // ② 再点一次第二格 = 取消选中。
    //    ⚠ 不能省：失败后选中会挪到第二格，紧接着点 (0,0) 会被当成「(4,3) ↔ (0,0)」那一对
    //    （同脸、绕得过去）直接消掉，第 3 步就测不到"成功后收提示"了。
    await clickCell(page, idx(4, 3));
    await expect.poll(() => page.locator('.llk-cell.is-selected').count(), { timeout: 4000 }).toBe(0);

    // ③ 紧接着消掉一对：提示必须跟这一次成功的渲染**同批**消失，而不是等 1.6s 定时器到期。
    //    判据取"同一次 DOM 快照"里的 cleared + tip，才能区分"主动清零"与"定时器到点"。
    //    （失败发生在 ~1.5s，定时器在 ~3.1s 才到；这一段不额外 sleep，快照落在定时器之前。）
    await clickCell(page, idx(0, 0));
    await clickCell(page, idx(0, 1));

    let snap = { cleared: false, tip: '?' };
    await expect.poll(async () => {
      snap = await page.evaluate(sel => {
        const a = document.querySelector(sel.a);
        const b = document.querySelector(sel.b);
        return {
          cleared: !a.getAttribute('data-face') && !b.getAttribute('data-face'),
          tip: (document.querySelector('.llk-click-tip')?.textContent ?? '').trim(),
        };
      }, { a: `.llk-cell[data-idx="${idx(0, 0)}"]`, b: `.llk-cell[data-idx="${idx(0, 1)}"]` });
      return snap.cleared;
    }, { timeout: 6000 }).toBe(true);

    const after = await readCells(page);
    check('LL-14-消除', after[idx(0, 0)] === 0 && after[idx(0, 1)] === 0 && after.filter(v => v > 0).length === 6,
      `两格=${after[idx(0, 0)]}/${after[idx(0, 1)]}，剩余块数=${after.filter(v => v > 0).length}（应 6）`);
    check('LL-14-清提示', snap.tip === '', `同一次快照里提示="${snap.tip}"（应为空；非空说明只在等定时器到点）`);

    // ④ 成功消除的格子不该抖（is-shake 只属于第 ① 步那两格，且已随提示一起清掉）
    checkEq('LL-14-消后不抖', await shakeIdx(page), []);
    check('LL-14-不跳重排', (await page.locator('.llk-reshuffle-tip').count()) === 0,
      `兜底对还在盘上，不该出重排提示（实际 ${await page.locator('.llk-reshuffle-tip').count()} 个）`);
  });

  // ───────────────────── H-015：连接线 / 三次提示 / 规则引导 ─────────────────────
  //
  // 三个 DOM 挂点（JS 侧的义务，见 wwwroot/js/llkline.js）：
  //   svg.llk-line-svg / polyline[data-llk-mode="success"|"hint"] / circle[data-llk-bend]
  // 动画结束**必须移除 SVG 节点**（不是只 opacity:0 留尸体）—— LL-16 的末态就是钉这条。

  test('LL-15 规则遮罩：首访弹 → 点开始消失 → 二次访问不再弹', async ({ page }) => {
    // 每个 test 都是新 context（localStorage 恒空），这里仍显式清一次：不依赖"环境恰好是空的"
    await open(page, '/lianliankan', 1400);
    await page.evaluate(() => localStorage.removeItem('jtjsym.llk.rulesSeen'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await sleep(1500);

    await expect.poll(() => page.locator('[role="dialog"]').count(), { timeout: 6000 }).toBe(1);

    const label = await page.getAttribute('[role="dialog"]', 'aria-label');
    const lines = await page.$$eval('.llk-rules-line', els => els.map(e => e.textContent.trim()));
    check('LL-15-文案', label === '连连看玩法' && lines.length === 4,
      `aria-label="${label}"，规则行数=${lines.length}（应 4）`);

    // 遮罩只盖 .llk-board-wrap，状态行在它上方仍可点 ⇒ 按钮必须自己 disabled，
    // 否则遮罩期点提示会起表 + 白扣一次，而高亮被遮住根本看不见
    check('LL-15-禁用', await page.locator('.llk-hint-btn').isDisabled(),
      '遮罩期提示按钮必须 disabled（它不在遮罩下面）');

    await page.locator('.llk-overlay-btn').click();
    await expect.poll(() => page.locator('[role="dialog"]').count(), { timeout: 6000 }).toBe(0);
    const seen = await page.evaluate(() => localStorage.getItem('jtjsym.llk.rulesSeen'));
    check('LL-15-落盘', seen === '1', `rulesSeen=${seen}（应是 "1"）`);

    // 二次访问：**不清** storage，直接再来一次
    await open(page, '/lianliankan', 1400);
    check('LL-15-不重弹', (await page.locator('[role="dialog"]').count()) === 0,
      `二次访问遮罩数=${await page.locator('[role="dialog"]').count()}（应 0）`);
  });

  test('LL-16 成功描线：点可连对 → 出现实线 polyline → 两格消除 → SVG 最终移除', async ({ page }) => {
    await openLlk(page);
    // 成对闸：1 号 ×2 + 2 号 ×2（兜底对，消完不成空盘 / 不跳胜局）
    await seedSession(page, {
      cells: cellsWith([[idx(0, 0), 1], [idx(0, 1), 1], [idx(7, 4), 2], [idx(7, 5), 2]]),
    });
    check('LL-16-前置', (await readCells(page)).filter(v => v > 0).length === 4,
      `块数=${(await readCells(page)).filter(v => v > 0).length}（应 4；!=4 说明档被成对闸丢弃）`);

    await clickCell(page, idx(0, 0));
    await clickCell(page, idx(0, 1));

    // ① 线先出来（相邻两格 ⇒ 0 拐，points 恰好两个坐标）
    await expect.poll(() => readLineSvg(page).then(s => s?.mode ?? ''), { timeout: 3000 }).toBe('success');
    const svg = await readLineSvg(page);
    const pts = (svg?.raw ?? '').trim().split(/\s+/).filter(Boolean);
    check('LL-16-两点', pts.length === 2, `points="${svg?.raw}"（相邻格应为 2 个点）`);

    // ② 两格消除
    await expect.poll(() => readCells(page).then(c => c[idx(0, 0)] + c[idx(0, 1)]), { timeout: 7000 }).toBe(0);

    // ③ SVG 必须被**移除**，不能只留一层 opacity:0 的尸体（740ms 生命周期 + 余量）
    await expect.poll(() => page.locator('svg.llk-line-svg').count(), { timeout: 6000 }).toBe(0);
    const left = (await readCells(page)).filter(v => v > 0).length;
    check('LL-16-末态', left === 2, `剩余块数=${left}（应 2：兜底那对）`);
  });

  test('LL-17 ③ 层：外圈 3 拐 → 虚线 + 拐点 + 贴盘边 + 「最多两次」文案且不抖', async ({ page }) => {
    await openLlk(page);
    // 布局 D（《39》§9，C# 实测）：12 块、1~6 各两张。整行 0 与整列 0 都被占，(0,0) 四邻全堵
    // ⇒ 3 拐里唯一的最省解必然走出盘外 ⇒ 钳到盘边这条判据才有东西可看。
    await seedSession(page, {
      cells: [
        1, 2, 3, 4, 5, 6,
        2, 0, 0, 0, 0, 0,
        3, 0, 0, 0, 0, 0,
        4, 0, 0, 0, 0, 0,
        5, 0, 0, 0, 0, 0,
        6, 0, 0, 0, 0, 1,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
      ],
      elapsed: 5,
    });
    check('LL-17-前置', (await readCells(page)).filter(v => v > 0).length === 12,
      `块数=${(await readCells(page)).filter(v => v > 0).length}（应 12）`);

    await clickCell(page, idx(0, 0));
    await clickCell(page, idx(5, 5));

    await expect.poll(() => readLineSvg(page).then(s => s?.mode ?? ''), { timeout: 3000 }).toBe('hint');
    const svg = await readLineSvg(page);

    check('LL-17-拐点', svg.bends >= 1, `data-llk-bend=${svg.bends} 个（3 拐路径应 ≥1）`);

    // 钳制（拍板 2）：SVGPointList 不能直接序列化，所以拿 points 字符串自己解析。
    // 判据 = ① 全部点落在棋盘矩形内（±1px）② 至少两处坐标贴着盘边（= 真的被钳到 EDGE=1，
    // 而不是被拉进格子中心：320 下 c=-1 会被 clamp(v, cell/2) 钳成 21，那是第 0 列中心）。
    const coords = svg.raw.trim().split(/\s+/).filter(Boolean).map(s => s.split(',').map(Number));
    const inside = coords.every(([x, y]) => x >= 0 && x <= svg.w && y >= 0 && y <= svg.h);
    const edgeHits = coords.filter(([x, y]) =>
      x <= 2 || x >= svg.w - 2 || y <= 2 || y >= svg.h - 2).length;
    check('LL-17-钳制', inside, `有点跑出棋盘（${svg.w}×${svg.h}）：${svg.raw}`);
    check('LL-17-贴边', edgeHits >= 2, `贴盘边的点=${edgeHits} 个（应 ≥2）：${svg.raw}`);

    // 两格不清除 + 不抖（③ 层的画面已经给了答案，再抖就是两个信号打架）
    const cells = await readCells(page);
    check('LL-17-未消除', cells[idx(0, 0)] === 1 && cells[idx(5, 5)] === 1,
      `两格=${cells[idx(0, 0)]}/${cells[idx(5, 5)]}（应都还在）`);
    checkEq('LL-17-不抖', await shakeIdx(page), []);

    await expect.poll(() => readClickTip(page), { timeout: 4000 }).toContain('最多拐两次弯');
    const tip = await readClickTip(page);
    check('LL-17-文案', tip.includes('最多拐两次弯'), `提示="${tip}"（③ 层保留解释，不是 ④ 的「这两张连不上」）`);
  });

  test('LL-18 ④ 层：完全没路 → 抖动 + 无任何 SVG + 整句「这两张连不上」', async ({ page }) => {
    await openLlk(page);
    // 布局 B（《39》§9）：(1,1)/(1,3) 同脸但无限拐也走不通；盘上另有可连对，所以不会触发重排
    await seedSession(page, {
      cells: [
        3, 3, 2, 6, 6, 0,
        5, 1, 2, 1, 8, 8,
        4, 4, 0, 7, 7, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 5,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
      ],
      elapsed: 6,
    });
    check('LL-18-前置', (await readCells(page)).filter(v => v > 0).length === 16,
      `块数=${(await readCells(page)).filter(v => v > 0).length}（应 16）`);

    await clickCell(page, idx(1, 1));
    await clickCell(page, idx(1, 3));

    // ⚠ 整句匹配，不用 toContainText：③ 的「连不上：最多拐两次弯」也含「连不上」，
    //   包含匹配分不出这两层，等于没看守"④ 用的是哪一句"
    await expect.poll(() => readClickTip(page), { timeout: 4000 }).toBe('这两张连不上');

    checkEq('LL-18-抖动', await shakeIdx(page), [idx(1, 1), idx(1, 3)]);
    check('LL-18-无线', (await page.locator('svg.llk-line-svg').count()) === 0,
      `SVG 数=${await page.locator('svg.llk-line-svg').count()}（④ 层不画线）`);
    const cells = await readCells(page);
    check('LL-18-未消除', cells[idx(1, 1)] === 1 && cells[idx(1, 3)] === 1,
      `两格=${cells[idx(1, 1)]}/${cells[idx(1, 3)]}（应都还在）`);
  });

  test('LL-19 提示三次：3→2→1→0、每次恰两格同脸 is-hint、0 后禁用、刷新仍 0', async ({ page }) => {
    await openLlk(page);
    await seedSession(page, {
      cells: cellsWith([[idx(0, 0), 1], [idx(0, 1), 1], [idx(7, 4), 2], [idx(7, 5), 2]]),
      elapsed: 4,
    });

    const hintText = () =>
      page.evaluate(() => (document.querySelector('.llk-hint-btn')?.textContent ?? '').trim());

    check('LL-19-初值', (await hintText()) === '提示 3', `按钮="${await hintText()}"（应「提示 3」）`);

    for (const left of [2, 1, 0]) {
      await page.locator('.llk-hint-btn').click();
      await expect.poll(hintText, { timeout: 4000 }).toBe(`提示 ${left}`);

      // is-hint 只有 2s 窗口，且 click() 返回 ≠ DOM 已更新 ⇒ 立刻 poll，不 sleep
      await expect.poll(() => page.locator('.llk-cell.is-hint').count(), { timeout: 2000 }).toBe(2);
      const faces = await page.$$eval('.llk-cell.is-hint', els => els.map(e => e.getAttribute('data-face')));
      check(`LL-19-同脸${left}`, faces.length === 2 && faces[0] === faces[1],
        `高亮两格 face=${faces.join('/')}（提示的必须是一对同脸）`);
    }

    check('LL-19-禁用', await page.locator('.llk-hint-btn').isDisabled(), '0 次后按钮应 disabled');

    // 刷新后仍是 0：次数随快照落盘（提示不升版，走 hints 可选字段）
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await sleep(1400);
    check('LL-19-持久', (await hintText()) === '提示 0',
      `刷新后按钮="${await hintText()}"（应「提示 0」；hints 若没落盘会回到 3）`);
    check('LL-19-持久禁用', await page.locator('.llk-hint-btn').isDisabled(), '刷新后仍应 disabled');
  });

  test('LL-20 提示高亮的是真对；已选中一格时提示跳过该格', async ({ page }) => {
    await openLlk(page);
    await seedSession(page, {
      cells: cellsWith([[idx(0, 0), 1], [idx(0, 1), 1], [idx(7, 4), 2], [idx(7, 5), 2]]),
    });

    // ① 未选中任何格：行优先的第一对 (0,0)/(0,1)
    await page.locator('.llk-hint-btn').click();
    await expect.poll(() => page.locator('.llk-cell.is-hint').count(), { timeout: 3000 }).toBe(2);
    const first = await page.$$eval('.llk-cell.is-hint', els =>
      els.map(e => Number(e.getAttribute('data-idx'))).sort((a, b) => a - b));
    checkEq('LL-20-第一对', first, [idx(0, 0), idx(0, 1)]);

    // 等它自然到期，免得下一次读串台（2s 生命周期）
    await expect.poll(() => page.locator('.llk-cell.is-hint').count(), { timeout: 6000 }).toBe(0);

    // ② 先选中 (0,0) 再点提示 ⇒ excludeIdx 生效，高亮里不能出现 (0,0)
    //    （否则同一格会同时吃 is-selected 和 is-hint，两个 outline 抢同一属性）
    await clickCell(page, idx(0, 0));
    await page.locator('.llk-hint-btn').click();
    await expect.poll(() => page.locator('.llk-cell.is-hint').count(), { timeout: 3000 }).toBe(2);
    const second = await page.$$eval('.llk-cell.is-hint', els =>
      els.map(e => Number(e.getAttribute('data-idx'))));
    check('LL-20-排除', !second.includes(idx(0, 0)),
      `已选中的 (0,0) 仍被高亮：${JSON.stringify(second)}`);
    checkEq('LL-20-第二对', second.sort((a, b) => a - b), [idx(7, 4), idx(7, 5)]);
  });

  // ─────────────── D-31：重排过渡（两阶段渲染，LL-21/LL-22） ───────────────

  test('LL-21 恢复死局档：先淡出再淡入，动画结束后可正常消一对', async ({ page }) => {
    await openLlk(page);          // 先走一遍规则遮罩（写 rulesSeen），否则下面的 reload 会再弹一次

    // 贴角 1/2/2/1 死局档：4 块、过成对闸、HasAnyPair=False、Reshuffle 后 True（已用临时探针实测）
    const dead = cellsWith([
      [idx(0, 0), 1], [idx(0, 1), 2],
      [idx(1, 0), 2], [idx(1, 1), 1],
    ]);
    const payload = JSON.stringify({ v: 1, issue: todayIssue(), cells: dead, elapsedSec: 5 });
    await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [SK, payload]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 });

    // ★ 这里绝不能 sleep：动画由恢复段在 reload 后立刻启动，470ms 全程就跑完了，
    //   睡过去就只能 poll 到"已经结束"，is-shuffle-out 一次都抓不到（§4.2 纪律 4）。
    await expect.poll(() => shuffleOutCount(page), TIGHT).toBeGreaterThan(0);
    check('LL-21-置忙', (await busyCount(page)) === 1,
      `淡出期间棋盘应标 data-llk-reshuffling（实际 ${await busyCount(page)} 个）`);

    await expect.poll(() => shuffleInCount(page), TIGHT).toBeGreaterThan(0);
    await expect.poll(() => busyCount(page), TIGHT).toBe(0);

    check('LL-21-剩4块', (await readCells(page)).filter(v => v > 0).length === 4,
      `重排不改变方块数（实际 ${(await readCells(page)).filter(v => v > 0).length}）`);
    const tip = (await page.textContent('.llk-reshuffle-tip').catch(() => ''))?.trim() ?? '';
    check('LL-21-飘字', tip === '无解自动重排', `飘字="${tip}"`);
    check('LL-21-动画已清', (await shuffleOutCount(page)) === 0 && (await shuffleInCount(page)) === 0,
      `结束后两个动画 class 都不该留在 DOM（out=${await shuffleOutCount(page)} in=${await shuffleInCount(page)}）`);
    check('LL-21-可消', await eliminateAnyPair(page), '重排后两两试过都没消掉（说明仍是死局）');
  });

  test('LL-22 消除引发重排：同样有过渡，窗口内的点击被吞掉', async ({ page }) => {
    await openLlk(page);

    // 6 块：初始只有 (0,0)↔(0,1) 这一对可连；消掉后第 0 行只剩 (0,2)/(0,3)，
    // 贴角 2×2 交错成死局（实测量过：消后 HasAnyPair=False、Reshuffle=True、重排后两对各相邻）。
    // ⚠ 别用《40》v1.0 那张「2×2 交错经典死局」—— 那张消完第 0 行就空了，face 2 走盘外 2 拐可连，
    //   根本不触发重排，用例会安静地什么都没验到。
    await seedSession(page, {
      cells: cellsWith([
        [idx(0, 0), 1], [idx(0, 1), 1],
        [idx(0, 2), 2], [idx(0, 3), 3],
        [idx(1, 2), 3], [idx(1, 3), 2],
      ]),
      elapsed: 5,
    });
    checkEq('LL-22-初始', (await readCells(page)).filter(v => v > 0).sort((a, b) => a - b), [1, 1, 2, 2, 3, 3]);

    await clickCell(page, idx(0, 0));
    // ★ 第二击用裸 click：clickCell 内含 sleep(220)，正好等于整个淡出窗口，会把动画睡过去
    await page.locator(`.llk-cell[data-idx="${idx(0, 1)}"]`).click();

    await expect.poll(() => shuffleOutCount(page), TIGHT).toBeGreaterThan(0);

    // 窗口内点一个**还在盘上**的格（face=2）。若这一击没被吞，动画结束后它必然是 is-selected；
    // 点已消掉的空格证明不了任何事（那种格在 OnCellClickedAsync 里本来就被 face==0 挡掉）。
    await page.locator(`.llk-cell[data-idx="${idx(0, 2)}"]`).click();
    await expect.poll(() => busyCount(page), TIGHT).toBe(0);

    // 固定等一小段再直读：那一击若真生效，它的往返可能晚于 busy 属性消失。
    // 这里**不能**用 expect.poll 判"选中数为 0" —— 本来就没发生的状态会立刻通过，零余量（D22-5）。
    await sleep(400);
    const selected = await page.locator('.llk-cell.is-selected').count();
    check('LL-22-吞点击', selected === 0,
      `动画窗口内的点击不该选中任何格（实际选中 ${selected} 个）`);
    check('LL-22-剩4块', (await readCells(page)).filter(v => v > 0).length === 4,
      `已消一对、重排不改数量，应剩 4 块（实际 ${(await readCells(page)).filter(v => v > 0).length}）`);
    check('LL-22-可消', await eliminateAnyPair(page), '重排后两两试过都没消掉（说明重排没救活）');
  });
});
