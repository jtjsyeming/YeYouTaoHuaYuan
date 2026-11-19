// H-014 / H-015 / D-31 / D-32 / H-016 / D-33 / D-34 / D-37 / D-38 / H-017 / D-39 / P-077 / H-018：
// 每日一关连连看（LL-01~LL-41）+ 关卡日历与服务端每日榜（LL-38~41，H-018）
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
//   ⑥ **重排动画（D-31 两阶段 + H-017 FLIP）的窗口：淡出 220ms、阶段 2 380ms、全程 600ms**，判据有三条硬约束：
//      a) "出现"必须单独成一步。单用 poll(busy 属性 === 0) 是无效锚点 —— 点击后 SignalR 往返期
//         属性还没加上，poll 立刻返回、后续断言在动画里跑（零余量，D22-5 同款）。
//      b) intervals 必须收紧。默认 [100,250,500,1000] 在 220ms 窗口上只剩 1~2 次采样。
//      c) 抓"恢复即重排"时**不能走 seedSession**：它自带 sleep(1100)，远大于 600ms 全程，
//         poll 到时动画早演完了。那条用例只能裸注入 + reload 后立刻 poll。
//      另：第二击之后**不能**用 clickCell（它内含 sleep 220 = 整个淡出窗口），必须裸 click。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
 * 正在跑 **script 动画**（FLIP）的格（H-017），按 data-idx 升序。
 *
 * 必须排掉 CSSTransition / CSSAnimation：44 个 is-gone 格自带 88 个带 transform 的过渡，
 * 「数有 transform 动画的格」在原地不动时也会数到 44 —— 那种判据在没实现 FLIP 时照样绿
 * （《48》v2.0 §1.5 逐时刻实测）。脚本动画才能区分"方块真的在飞"。
 */
const flipDetail = page => page.evaluate(() => {
  const isScript = a =>
    typeof Animation !== 'undefined' && a instanceof Animation &&
    !(typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) &&
    !(typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation);
  const hasTransform = a =>
    isScript(a) && (a.effect?.getKeyframes?.() ?? []).some(k => 'transform' in k);

  return [...document.querySelectorAll('.llk-cell')]
    .filter(el => el.getAnimations().some(hasTransform))
    .map(el => {
      const a = el.getAnimations().find(hasTransform);
      const first = (a.effect?.getKeyframes?.() ?? [])[0]?.transform ?? '';
      const m = /translate\(([-\d.]+)(?:px)?,\s*([-\d.]+)(?:px)?\)/.exec(first);
      return {
        idx: Number(el.dataset.idx),
        dx: m ? Number(m[1]) : null,
        dy: m ? Number(m[2]) : null,
        fly: el.classList.contains('is-shuffle-fly'),
        raw: first,
      };
    })
    .sort((x, y) => x.idx - y.idx);
});

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

    // ⚠ H-016 起 style 里多一个常量 `--fc:<族色>`（兜底字牌左侧色条用）。
    //   若还拿**整串 style** 去重，24 张脸即便全挤在同一个 (c,r)、只要 accent 不同也照样"24 个不同"
    //   ⇒ 这条守卫会被悄悄废掉（改造让旧断言变成看别的东西，C-68 同款教训）。
    //   所以只解析真正承担区分的那两个变量。
    const info = await page.$$eval('.llk-cell', els => els.map(e => {
      const style = e.getAttribute('style') || '';
      const c = /--c:\s*(-?\d+)/.exec(style)?.[1];
      const r = /--r:\s*(-?\d+)/.exec(style)?.[1];
      return { face: e.getAttribute('data-face'), pos: `${c},${r}` };
    }));

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
      `24 张脸对应 ${new Set(positions).size} 个不同的格位；示例(--c,--r)=${JSON.stringify(positions.slice(0, 3))}`);
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

    // ★ 这里绝不能 sleep：动画由恢复段在 reload 后立刻启动，600ms（220 + 380）全程就跑完了，
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

  test('LL-23 消除瞬间图案不跳变：sprite 停在原位（D-32）', async ({ page }) => {
    await openLlk(page);

    // 成对闸：9 号 ×2（目标对，相邻可连）+ 1 号 ×2（兜底对，防"消完即胜局"）。
    // ⚠ 目标对**必须 face ≥ 2**：Position(1) = (0,0) 恰好等于渲染兜底，face 1 的对
    //   在修复前后都看不出跳变 ⇒ 用例退化成橡皮图章（《43》§1.1 实测：LL-16 用的就是 face 1）。
    //   取 9 —— Position(9) = (2,1)，两个轴都非零，失败信息最直观。
    const A = idx(0, 0);
    const B = idx(0, 1);
    await seedSession(page, {
      cells: cellsWith([[A, 9], [B, 9], [idx(7, 4), 1], [idx(7, 5), 1]]),
      elapsed: 5,
    });
    check('LL-23-前置块数', (await readCells(page)).filter(v => v > 0).length === 4,
      `块数=${(await readCells(page)).filter(v => v > 0).length}（应 4；!=4 说明档被成对闸丢弃）`);

    // 判据通道 = background-position：它是"图案在哪"的直接观测量。
    // ⚠ 别拿 --c/--r 当判据（那是机制名，钉成契约后换个实现就假红），只放进失败文案。
    const readPos = i =>
      page.evaluate(n => {
        const e = document.querySelector(`.llk-cell[data-idx="${n}"]`);
        const cs = getComputedStyle(e);
        return {
          bg: cs.backgroundPosition,
          c: e.style.getPropertyValue('--c'),
          r: e.style.getPropertyValue('--r'),
        };
      }, i);

    const before = await readPos(A);
    // ★ 这条是"判据不是橡皮图章"的看守：兜底是 0% 0%，基线若等于它，本用例什么都守不住
    check('LL-23-基线非兜底', before.bg !== '0% 0%',
      `基线 bgPos=${before.bg}（--c:${before.c};--r:${before.r}）—— 等于兜底 0% 0% 说明造盘选了 face 1，用例失效`);

    await page.locator(`.llk-cell[data-idx="${A}"]`).click();
    await sleep(120);
    // ★ 第二击用裸 click（clickCell 内含 sleep(220)，会把描线窗口睡过去）
    await page.locator(`.llk-cell[data-idx="${B}"]`).click();

    // 约束 1：锚点必须**按格**，不能数 is-gone 总数 —— 这张盘只有 4 块，另外 44 格本来就是 is-gone。
    // 它同时兼任"渲染已落地"：实测 is-gone / data-face 消失 / --c 跳变在同一帧（第二击后 ~21ms）。
    await expect.poll(
      () => page.locator(`.llk-cell[data-idx="${A}"].is-gone`).count(),
      { intervals: [10, 10, 25, 25, 50, 100], timeout: 3000 },
    ).toBe(1);

    // 本条窗口是**单向**的（与 D-30/D-31 相反）：消除后 --c/--r 再也不变 ⇒ 读晚了没关系、读早了才假绿，
    // 而"读早了"已被上面那个 poll 挡住 ⇒ 不需要 D-31 那种极紧的采样。
    const after = await readPos(A);
    check('LL-23-不跳变', after.bg === before.bg,
      `消除后 bgPos=${after.bg}（--c:${after.c};--r:${after.r}），基线 ${before.bg} —— 跳变说明 sprite 被重置到第 1 张脸`);

    check('LL-23-挡掉脸但留图案', (await page.getAttribute(`.llk-cell[data-idx="${A}"]`, 'data-face')) === null,
      'data-face 必须消失（LL-12 的 {1..24} 契约）；本修复只保 --c/--r，不保 data-face');
  });

  // ─────────────── H-016 / D-33 / D-34：sprite 画不出来时的降级兜底（LL-24~LL-28） ───────────────
  // 五条共用三条前置纪律，少一条就变橡皮图章：
  //   ① **一律 openLlk**：首访玩法遮罩 inset:0 会盖住棋盘（《39》一次撞红 9 条）。
  //   ② **route 必须在首次导航之前注册**，且用 `page.route`（不是 `context.route`）——
  //      openLlk 内含一次 reload，两次导航都得被拦。
  //   ③ **锚点用 `data-llk-sprite`**：absent（没这容器）/ pending（探测中）/ ok / fallback。
  //      负向断言必须配一个正面锚（先等到 ok），否则"探测根本没跑"也照样绿的。
  // 为什么值得五条：`request.get('/Images/llk/faces.png') === 200`（LL-01）证明的是**服务器有**，
  //   不是**浏览器画了**；`getComputedStyle().backgroundImage` 在 404 / 被拦时照样返回那条 url。
  //   这两条盲区就是 D-33 能在真机上活下来的原因（《44》§1.3）。
  // D-34 的两条新纪律（《45》§6，照抄会出假绿）：
  //   ④ **"条目存在" ≠ "资源可用"**：被 `route.abort()` 的请求**照样产生 Resource Timing 条目**
  //      （`responseStatus: 0`、各 size 全 0）。判"图拉到了"只能锚 `responseStatus === 200`，
  //      且必须**先把相对路径归一化成绝对 URL** —— `getEntriesByName` 是精确匹配，
  //      传 '/Images/llk/faces.png' 恒返回空（实测 0 vs 1），照抄等于修复没生效、用例也一起假绿。
  //   ⑤ **"模拟无图模式"按机制模拟，不要按请求序号模拟**：CSS 背景图成功之后 `new Image()`
  //      命中内存缓存、**不发第二个请求**（实测 route handler 只被调用 1 次），所以"放行第一次、
  //      拦截后续"根本触发不了第二次拦截。造"CSS 成、JS 败"只有一条稳路：`addInitScript` 打桩
  //      `Image` 的 `src` setter（LL-27 已验证）。反过来"两者都败"用 `route.abort()`（LL-24 已覆盖），
  //      两条交替才能把四个象限占全。

  test('LL-24 图被拦 → 降级牌面可用（H-016）', async ({ page }) => {
    await page.route('**/Images/llk/faces.png', r => r.abort());
    await openLlk(page);

    // abort ⇒ img.onerror 立刻回调，降级几乎与首帧同时到，不需要等 5s 超时
    await expect.poll(
      () => page.getAttribute('.llk-board', 'data-llk-sprite'),
      { timeout: 3000, intervals: [50, 100, 200, 500] },
    ).toBe('fallback');

    check('LL-24-降级类', (await page.locator('.llk-board.llk-no-sprite').count()) === 1,
      'data-llk-sprite=fallback 但棋盘上没有 .llk-no-sprite（两者必须同时成立）');

    const card = await page.evaluate(() => {
      const cell = document.querySelector('.llk-cell[data-face]');
      const fb = cell ? cell.querySelector('.llk-face-fb') : null;
      const cs = getComputedStyle(cell);
      const fs = fb ? getComputedStyle(fb) : null;
      return {
        hasCard: !!fb,
        text: fb ? fb.textContent : '',
        display: fs ? fs.display : '',
        color: fs ? fs.color : '',
        bgImage: cs.backgroundImage,
        bgColor: cs.backgroundColor,
      };
    });

    check('LL-24-牌面可见', card.hasCard && card.display === 'flex',
      `兜底字牌应 display:flex（实际 hasCard=${card.hasCard} display="${card.display}"）`);
    check('LL-24-两字标', card.text.length === 2, `字牌文案="${card.text}"（应恰好两字）`);
    check('LL-24-sprite已关', !card.bgImage.includes('faces.png') && card.bgImage.includes('data:image/svg+xml'),
      // D-39 起降级态**不再**把 background-image 清成 none，而是收成"只剩字牌图"的一层
      //（理由见 LianLianKan.razor 里 .llk-board.llk-no-sprite 的注释）。判据因此从"等于 none"
      // 改成"不声明 sprite 且声明了字牌图" —— 严格说更紧了：前者任何非 sprite 值都能过。
      `降级后应只剩字牌层（backgroundImage="${card.bgImage.slice(0, 56)}…"）`);
    check('LL-24-米纸底', card.bgColor === 'rgb(243, 236, 225)',
      `格子底色=${card.bgColor}（应 #F3ECE1，与字牌同值）`);
    // 固定深字 12.07:1 —— 是这条降级存在的唯一理由（族色底 + 白字有 14/24 格不达标）
    check('LL-24-固定深字', card.color === 'rgb(43, 43, 43)', `字色=${card.color}（应 #2B2B2B）`);
  });

  test('LL-25 图迟到 → 先降级、后恢复（onLateOk）', async ({ page }) => {
    // 图晚于 5s 超时才到：先给字牌，图真到了再撤降级（弱网"先字后图"）。
    // ⚠ 延迟取 8000 而不是刚过 5s 的 6000：openLlk 内部先 settle 1600ms 才 reload，
    //   第二个请求要等这次导航才开始计时 —— 6000 时"fallback → ok"之间只剩约 0.8s，
    //   poll 有可能整段错过 fallback（读到了 ok，然后判 fallback 失败）。
    //   单跑约 11~12s 属已知成本：5s 是产品行为，不能为了跑得快去改产品。
    await page.route('**/Images/llk/faces.png', async r => {
      await sleep(8000);
      // 第一次导航那个请求会被 reload 打断，continue 会抛目标已关闭 —— 那是预期，忽略
      await r.continue().catch(() => {});
    });
    await openLlk(page);

    await expect.poll(
      () => page.getAttribute('.llk-board', 'data-llk-sprite'),
      { timeout: 10_000, intervals: [150, 200, 300, 500] },
    ).toBe('fallback');
    check('LL-25-先降级', (await page.locator('.llk-board.llk-no-sprite').count()) === 1,
      '超时后应停在字牌（.llk-no-sprite）');

    // ★ 这一条就是 v1.0 缺的那条：`settled` 之后直接 return ⇒ 图迟到也永远不会恢复
    await expect.poll(
      () => page.getAttribute('.llk-board', 'data-llk-sprite'),
      { timeout: 8000, intervals: [150, 200, 300, 500] },
    ).toBe('ok');
    check('LL-25-已撤销降级', (await page.locator('.llk-board.llk-no-sprite').count()) === 0,
      '图到了以后 .llk-no-sprite 必须撤掉（否则弱网用户永久停在字牌）');
    check('LL-25-图回来', (await page.evaluate(
      () => getComputedStyle(document.querySelector('.llk-cell[data-face]')).backgroundImage,
    )).includes('faces.png'), '恢复后格子应重新声明 sprite');
  });

  test('LL-26 主路径零变化（正面锚：探测确实跑过）', async ({ page }) => {
    await openLlk(page);

    // 正面锚：不等到 "ok" 就无法区分"探测通过"与"探测根本没跑"（catch 里静默吞掉同样绿）
    await expect.poll(
      () => page.getAttribute('.llk-board', 'data-llk-sprite'),
      { timeout: 3000, intervals: [50, 100, 200, 500] },
    ).toBe('ok');

    // 正面锚成立之后只取一次样：这条状态本来就不该出现，写成"盯 N 秒"是零余量判据（D22-5 教训）
    check('LL-26-未降级', (await page.locator('.llk-board.llk-no-sprite').count()) === 0,
      '正常路径下棋盘不该有 .llk-no-sprite');

    const card = await page.evaluate(() => {
      const cell = document.querySelector('.llk-cell[data-face]');
      return {
        fbDisplay: getComputedStyle(cell.querySelector('.llk-face-fb')).display,
        bgImage: getComputedStyle(cell).backgroundImage,
      };
    });
    check('LL-26-牌面隐藏', card.fbDisplay === 'none',
      `正常态字牌必须 display:none（实际 "${card.fbDisplay}"）—— 48 格布局零变化`);
    check('LL-26-sprite在', card.bgImage.includes('faces.png'),
      `正常态格子应声明 sprite（backgroundImage="${card.bgImage}"）`);
  });

  // ─────────────── D-34：降级误判修掉"明明能画却被摘图"（LL-27 / LL-28） ───────────────
  // 造"CSS 成、JS 败"的唯一稳路（组注释 ⑤）：打桩 Image 的 src setter，让探针必 error。
  // ⚠ 必须 addInitScript —— openLlk 内含一次 reload，只注入一次会丢。
  const stubProbeFail = page => page.addInitScript(() => {
    const RealImage = window.Image;
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    window.__llkProbeHits = 0;
    window.Image = function () {
      const img = new RealImage();
      Object.defineProperty(img, 'src', {
        configurable: true,
        get() { return desc.get.call(img); },
        set() {
          window.__llkProbeHits += 1;
          setTimeout(() => img.dispatchEvent(new Event('error')), 0);
        },
      });
      return img;
    };
  });

  test('LL-27 CSS 已拉到 + JS 探针必败 → 不降级（D-34）', async ({ page }) => {
    // 模拟用户的手机：CSS 背景图正常拉（真实网络），JS new Image() 必失败。
    await stubProbeFail(page);
    await openLlk(page);

    await expect.poll(
      () => page.getAttribute('.llk-board', 'data-llk-sprite'),
      { timeout: 5000, intervals: [50, 100, 200, 500] },
    ).toBe('ok');

    check('LL-27-未降级', (await page.locator('.llk-board.llk-no-sprite').count()) === 0,
      'CSS 图明明拉到了，探针失败不该把 sprite 摘掉（这就是 D-34）');
    check('LL-27-走条目闸', (await page.getAttribute('.llk-board', 'data-llk-sprite-src')) === 'css',
      '应为 css（条目闸短路），若为 probe 说明闸门没生效、只是碰巧探针成功');
    check('LL-27-图仍在', (await page.evaluate(
      () => getComputedStyle(document.querySelector('.llk-cell[data-face]')).backgroundImage,
    )).includes('faces.png'), '格子必须继续声明 sprite');
    // 场景锚 ①：条目真的在且 responseStatus=200 —— 这是「CSS 成」这一半的事实依据。
    //   ⚠ 它本身没有判别力（无修复时也绿），作用是不让"根本没收图"也冒充成"条目闸生效"。
    const rt = await page.evaluate(() => {
      const abs = new URL('/Images/llk/faces.png', document.baseURI).href;
      const es = performance.getEntriesByName(abs);
      return { n: es.length, status: es.map(e => e.responseStatus ?? 200) };
    });
    check('LL-27-条目200', rt.n >= 1 && rt.status.includes(200),
      `应能找到该 URL 的条目且 responseStatus=200（实际 ${JSON.stringify(rt)}）`);

    // 场景锚 ②：打桩确实装上了 —— 手动 new 一次 Image，必须立刻 error。
    //   注：**不能**用"探针被调用过"当锚 —— 条目闸生效时探针本来就该零出场（hits 恒 0）。
    const probe = await page.evaluate(async () => {
      const before = window.__llkProbeHits;
      const img = new Image();
      const p = new Promise(res => {
        img.onerror = () => res('error');
        img.onload = () => res('load');
        setTimeout(() => res('timeout'), 800);
      });
      img.src = '/Images/llk/faces.png';
      return { delta: window.__llkProbeHits - before, outcome: await p };
    });
    check('LL-27-打桩生效', probe.delta === 1 && probe.outcome === 'error',
      `JS 侧取图必须失败（实际 ${JSON.stringify(probe)}）—— 否则这条用例没造出 D-34 的场景`);
  });

  test('LL-28 降级后条目到了 → 自动撤销降级（退避复查）', async ({ page }) => {
    // 打桩让 onLateOk 永远不可能触发（否则这条会被"迟到恢复"救活，测不到退避复查本身）
    await stubProbeFail(page);
    // CSS 请求晚 6s 放行：探针瞬 error ⇒ 立刻降级；图片 6s 后才完成 ⇒ 条目此时才出现
    await page.route('**/Images/llk/faces.png', async r => {
      await sleep(6000);
      await r.continue().catch(() => {});   // 第一次导航被 reload 打断时 continue 会抛，忽略
    });
    await openLlk(page);

    await expect.poll(
      () => page.getAttribute('.llk-board', 'data-llk-sprite'),
      { timeout: 10_000, intervals: [100, 200, 300, 500] },
    ).toBe('fallback');
    check('LL-28-先降级', (await page.locator('.llk-board.llk-no-sprite').count()) === 1, '应停在字牌');

    // 退避 1/2/4/8 ⇒ 降级后约 8~9s 命中，给 15s 上限
    await expect.poll(
      () => page.getAttribute('.llk-board', 'data-llk-sprite'),
      { timeout: 15_000, intervals: [200, 300, 500, 1000] },
    ).toBe('ok');
    check('LL-28-已撤销降级', (await page.locator('.llk-board.llk-no-sprite').count()) === 0,
      '退避复查没跑（本用例里 onLateOk 不可能触发：探针被打桩成永远 error）');
    check('LL-28-来源为css', (await page.getAttribute('.llk-board', 'data-llk-sprite-src')) === 'css',
      '恢复必须由条目闸给出，不是探针');
    check('LL-28-图回来', (await page.evaluate(
      () => getComputedStyle(document.querySelector('.llk-cell[data-face]')).backgroundImage,
    )).includes('faces.png'), '撤了 class 就该重新声明 sprite（图在缓存里，无需再等）');
  });

  // ─────────────── D-37：两折可连被误判「连不上」（LL-29） ───────────────
  test('LL-29 两折可连不再误判「连不上」（D-37）', async ({ page }) => {
    // 4 块最小盘（《47》v2.0 §1.2）：face1 = (0,0)/(5,4) 就是"两折可连"的那一对，face2 只作障碍。
    // 4 块 = 2 对，满足 seedSession 的成对闸（奇数档会被 TryFrom 静默丢弃 ⇒ 回落真实每日盘，本用例假绿）。
    // 修复前：无界 TryFindPath 首次命中即返回、同层内多报 1 拐（2 → 3）⇒ 页面落 ③ 层 ⇒ 本用例必红。
    await openLlk(page);
    await seedSession(page, {
      cells: cellsWith([[idx(0, 0), 1], [idx(0, 3), 2], [idx(4, 0), 2], [idx(5, 4), 1]]),
    });
    const before = (await readCells(page)).filter(v => v > 0).length;
    check('LL-29-前置', before === 4,
      `块数=${before}（应 4；注入档被成对闸丢弃时会退回真实每日盘 = 48）`);

    await clickCell(page, idx(0, 0));
    await clickCell(page, idx(5, 4));

    // 修复前停在 ③ 层（不消除），poll 超时即红
    await expect.poll(() => readCells(page).then(c => c[idx(0, 0)]), { timeout: 4000 }).toBe(0);
    const line = await readLineSvg(page);
    check('LL-29-实线', line?.mode === 'success', `data-llk-mode="${line?.mode}"（应 success）`);
    check('LL-29-无虚线', (await page.locator('.llk-cell.is-hint').count()) === 0,
      '不该出现提示虚线（③ 层的残留）');
  });

  // ─────────────── D-38：连线漂移（LL-30） ───────────────
  test('LL-30 连线不漂移：参照格被消掉后，端点仍对齐格中心（D-38）', async ({ page }) => {
    // 造盘（《48》v2.0 §4.2）：目标对 face5 在 (0,1)/(1,0)，1 拐经 (0,0)；face7 在 (6,4)/(6,5) 只作陪跑。
    // ★ 关键是 (0,0) **空**：旧版拿 idx 0 当固定参照，它一进 is-gone 就缩到 60%，而 idx 1 / idx 6 仍活着，
    //   误差无法相互抵消 —— 三格同时被消时才抵消（那正是 v1.0 那个盘恒绿的根因：cx 误差恰为 0）。
    await openLlk(page);
    await seedSession(page, {
      cells: cellsWith([[idx(0, 1), 5], [idx(1, 0), 5], [idx(6, 4), 7], [idx(6, 5), 7]]),
    });
    const before = (await readCells(page)).filter(v => v > 0).length;
    check('LL-30-前置', before === 4,
      `块数=${before}（应 4；注入档被成对闸丢弃时会退回真实每日盘 = 48）`);

    await clickCell(page, idx(0, 1));
    await clickCell(page, idx(1, 0));

    await expect.poll(() => readLineSvg(page).then(s => s?.mode ?? ''), { timeout: 3000 }).toBe('success');
    const svg = await readLineSvg(page);

    const pts = (svg?.raw ?? '').trim().split(/\s+/).filter(Boolean).map(s => s.split(',').map(Number));
    // 正面锚：1 拐 = 3 个点。少于 3 多半是线压根没画出来（v1.0 那条"取不到基准就不画"的兜底），
    // 那样下面的几何比对会在空数组上"全部通过"。
    check('LL-30-三点', pts.length === 3,
      `points="${svg?.raw}"（(0,1)-(0,0)-(1,0) 这条 1 拐路径应为 3 个点）`);

    // 期望中心必须用**布局值**（offsetLeft/offsetTop）：
    //   getBoundingClientRect 是 llkline.js 自己的公式（等于自证），而且会吃 transform: scale(.6)。
    // .llk-board 是 position: relative ⇒ offsetParent 就是它，两者都是 padding box 口径。
    const want = await page.evaluate(ids => {
      const board = document.querySelector('.llk-board');
      return ids.map(i => {
        const el = board.querySelector(`[data-idx="${i}"]`);
        return [el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2];
      });
    }, [idx(0, 1), idx(0, 0), idx(1, 0)]);

    // 按"最近中心"一一匹配，不假设点的先后（起点由点击顺序决定，路径反过来依然算对）
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let worst = 0;
    const used = new Set();
    for (const p of pts) {
      let bestI = -1;
      let bestD = Infinity;
      want.forEach((w, i) => {
        if (used.has(i)) return;
        const d = dist(p, w);
        if (d < bestD) { bestD = d; bestI = i; }
      });
      if (bestI >= 0) used.add(bestI);
      worst = Math.max(worst, bestD);
    }
    check('LL-30-对齐', used.size === 3 && worst <= 2,
      `最坏偏差 ${worst.toFixed(2)}px（应 ≤2；旧版参照格被消时按 0.2×格宽/步推歪，320 档约 10px、桌面约 11.8px）`);
  });

  // ─────────────── H-017：重排「打乱重排」FLIP 动画（LL-31） ───────────────
  test('LL-31 重排是「打乱重排」：两个方块从旧位置滑到新位置（H-017）', async ({ page }) => {
    await openLlk(page);          // 先走一遍规则遮罩（写 rulesSeen），否则下面的 reload 会再弹一次

    // 与 LL-21 同一张贴角死局档：4 块、过成对闸、HasAnyPair=False、Reshuffle 后 True。
    // 重排后的盘必然"不是原样"（原样是死局，Reshuffle 不会停在那里），而 2×2 贴角 + 2 头像的
    // 6 种排列里可连的 4 种都只差一次交换 ⇒ **恰好 2 个格在动**（373 个期号实测 min=max=2，不是概率）。
    const dead = cellsWith([
      [idx(0, 0), 1], [idx(0, 1), 2],
      [idx(1, 0), 2], [idx(1, 1), 1],
    ]);
    const payload = JSON.stringify({ v: 1, issue: todayIssue(), cells: dead, elapsedSec: 5 });
    await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [SK, payload]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 });

    // ★ 这里绝不能 sleep：动画由恢复段在 reload 后立刻启动，600ms 全程跑完就只能 poll 到"已结束"。
    //   也不能用 seedSession（内含 sleep(1100)）—— 同 LL-21 纪律 (c)。
    await expect.poll(() => busyCount(page), TIGHT).toBe(1);
    await expect.poll(() => shuffleInCount(page), TIGHT).toBeGreaterThan(0);

    let flying = [];
    await expect.poll(async () => (flying = await flipDetail(page)).length, TIGHT).toBe(2);

    check('LL-31-飞行class', flying.every(f => f.fly),
      `is-shuffle-fly=${flying.map(f => f.fly).join(',')}（应全 true：z-index 抬层靠这个 class）`);
    check('LL-31-位移非零', flying.every(f => f.dx !== null && (f.dx !== 0 || f.dy !== 0)),
      `keyframes=${JSON.stringify(flying.map(f => f.raw))}（应为 translate(dx,dy) 且非零）`);

    // 一次交换 ⇒ 两段位移互为相反数（容差 1px：Math.round 与亚像素）
    const [m1, m2] = flying;
    check('LL-31-互为相反数', Math.abs(m1.dx + m2.dx) <= 1 && Math.abs(m1.dy + m2.dy) <= 1,
      `位移1=${m1.dx},${m1.dy} 位移2=${m2.dx},${m2.dy}（应互为相反数）`);

    // |位移| 必须等于这两格的**中心距**：位移的定义就是"旧中心 − 新中心"，两格互换后
    // 正好等于互相之间的距离。中心用布局值算（offsetLeft/offsetWidth 不吃 transform）。
    const centers = await page.evaluate(ids => {
      const board = document.querySelector('.llk-board');
      return ids.map(i => {
        const el = board.querySelector(`[data-idx="${i}"]`);
        return [el.offsetLeft + el.offsetWidth / 2, el.offsetTop + el.offsetHeight / 2];
      });
    }, [m1.idx, m2.idx]);
    const gap = Math.hypot(centers[0][0] - centers[1][0], centers[0][1] - centers[1][1]);
    const len = Math.hypot(m1.dx, m1.dy);
    check('LL-31-位移等于中心距', Math.abs(len - gap) <= 1.5,
      `|位移|=${len.toFixed(2)}px，两格中心距=${gap.toFixed(2)}px（应相等）`);

    await expect.poll(() => busyCount(page), TIGHT).toBe(0);
    check('LL-31-清场', (await shuffleOutCount(page)) === 0 && (await shuffleInCount(page)) === 0,
      `结束后两个动画 class 都不该留在 DOM（out=${await shuffleOutCount(page)} in=${await shuffleInCount(page)}）`);
    // onfinish 真的跑了（class 由 JS 摘，不靠 React/Blazor 重渲染）
    await expect.poll(() => page.locator('.llk-cell.is-shuffle-fly').count(), TIGHT).toBe(0);

    // 继承 LL-21 的"动画后可玩"
    check('LL-31-可消', await eliminateAnyPair(page), '重排后两两试过都没消掉（说明仍是死局）');
  });

  // ═══════════════ D-39：手机端第三轮「图标仍不可见」═══
  // 这一轮不再去猜"图有没有被画出来"，改问两件能一次量清的事：
  //   ① 格子有没有**地方**画（比例塌陷 → 2px，sprite 与字牌同时不可见）；
  //   ② 图没画出来时，有没有**不依赖 JS/暗化**的东西顶上来（字牌图 + 多层叠序）。

  // ─────────────── 暗化 opt-out 的两条独立声明（LL-33 / LL-34） ───────────────
  // 为什么拆两条而不是一条"meta 在 + computed 含 only light"：两种失效方式（只删 meta / 只删
  // :root 规则）在单条用例里会**互相掩盖** —— 双保险的意义就是任一还在都能过，但"有人删了一条"
  // 这个事实该有人看得见。
  test('LL-33 页头声明 color-scheme=only light（D-39 / P3）', async ({ page }) => {
    await open(page, '/lianliankan', 700);
    const content = await page.evaluate(() => {
      const m = document.querySelector('meta[name="color-scheme"]');
      return m ? (m.getAttribute('content') || '').trim().toLowerCase() : null;
    });
    // 用 trim + 小写比较，不用 `content*="only light"`：属性顺序与空白都可能变，
    // 而且选择器里再写一遍大小写等于把同一个假设写两处。
    check('LL-33', content === 'only light', `content="${content}"（应 only light）`);
  });

  test('LL-34 :root 的 color-scheme 被解析成 light only（D-39 / P3）', async ({ page }) => {
    await open(page, '/lianliankan', 700);
    const cs = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    // ⚠ 期望值是 **`light only`**，不是 `only light`：Chromium 156 / Firefox 157 实测都按规范
    //   序列化成前者。写成 `only light` 会两个浏览器恒假（《50》v1.0 的判据就栽在这）。
    check('LL-34', cs === 'light only', `computed colorScheme="${cs}"（应 light only）`);
  });

  // ─────────────── 比例零依赖（LL-35 / LL-36） ───────────────
  test('LL-35 320×568 下格子仍是 1:1 且不小于 40px（D-39 / P1）', async ({ browser }) => {
    // ⚠ 这条在 CI 上**不可能红**：Chromium 156 / Firefox 157 都支持 aspect-ratio，走的是
    //   @supports 覆盖分支 —— 把 padding-bottom 兜底整个删掉，它照样绿。它守的是"新内核分支
    //   没被兜底改动弄坏"（防止有人把兜底写错、连带把 aspect-ratio 那条也弄坏）。
    //   真正守"有人删了兜底"的是 LL-36 的静态判据。**别因为"删了不红"就把它删掉** ——
    //   那正是《49》LL-32 的教训（拆一层不红 ≠ 用例没价值）。
    const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    const mp = await ctx.newPage();
    await open(mp, '/lianliankan', 1400);
    const m = await mp.evaluate(() => {
      const r = document.querySelector('.llk-cell').getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    await ctx.close();

    const ratio = m.h === 0 ? Infinity : m.w / m.h;
    check('LL-35-比例', ratio >= 0.98 && ratio <= 1.02,
      `${m.w.toFixed(2)}×${m.h.toFixed(2)}，比例 ${ratio.toFixed(3)}（应 1 ±0.02）`);
    check('LL-35-高度', m.h >= 40,
      `格高 ${m.h.toFixed(2)}px（应 ≥40；比例塌陷时这里读到 2.0，整盘变成 58px 扁带）`);
  });

  test('LL-36 三处关键声明还在（D-39 / P1+P2，静态）', async () => {
    // 静态判据，不开浏览器：读产品源码。LL-35 守不住"兜底被删"（见它的注释），这条才是守卫。
    const raw = fs.readFileSync(
      new URL('../../../jtjsym/jtjsym/Pages/MyPage/LianLianKan.razor', import.meta.url), 'utf8');
    // ★ 先剥掉 CSS 注释再判。教训来自本用例的红检：注释里写着 `var(--fb, none)` 与 "600% 400%"，
    //   于是把真声明里的兜底删掉，判据照样命中注释、照样绿 —— **判据被注释满足**，等于没判。
    //   这类"守卫看的不是它以为的东西"比判据缺失更难发现（《50》§4.2 红检第一次跑出来的）。
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '');

    check('LL-36-比例兜底', /padding-bottom:\s*100%/.test(src),
      'P1 的比例兜底被删了 —— 不支持 aspect-ratio 的内核上格高会塌成上下 border 的 2px');
    check('LL-36-var兜底', (src.match(/var\(--fb,\s*none\)/g) || []).length === 2,
      '`var(--fb, none)` 应出现 **2** 次（.llk-cell 与 .llk-no-sprite 各一）；少一处就等于让没有 --fb 的格子把整条 background-image 计算成 none，连 sprite 一起丢');
    check('LL-36-两组尺寸', /background-size:\s*600% 400%,\s*100% 100%/.test(src),
      'size 退成一组时浏览器按列表循环复用第一组，字牌层拿到 600% 400% 被放大 6 倍');
  });

  // ─────────────── 字牌图 + 多层叠序（LL-37） ───────────────
  test('LL-37 两层背景：sprite 在上、字牌图在下；拦图降级后只剩字牌层（D-39 / P2）', async ({ page }) => {
    // ⚠ 与《50》§4.1 的原文有一处**有意的差异**：原文把"backgroundSize 两组（逗号数 1）"写在
    //   "拦掉 faces.png 之后"量。实测那样量不到 —— 拦图会让 JS 走进 fallback、给棋盘加
    //   .llk-no-sprite，而那条规则（提前降级的显式开关）本来就把两层收成一层，size 只剩一组。
    //   所以这里拆成两段：**正常态**判两层 + 两组 size；**降级态**判"只剩字牌层"。
    await openLlk(page);

    const two = await page.evaluate(() => {
      const c = document.querySelector('.llk-cell[data-idx="0"]');
      const cs = getComputedStyle(c);
      return {
        bg: cs.backgroundImage,
        size: cs.backgroundSize,
        pos: cs.backgroundPosition,
        fb: cs.getPropertyValue('--fb').trim(),
        cls: c.className,
      };
    });
    check('LL-37-两层', two.bg.includes('faces.png') && two.bg.includes('data:image/svg+xml'),
      `正常态应同时声明 sprite 与字牌图（实际 "${two.bg.slice(0, 70)}…"）`);
    // ⚠ 判据是**第二层的值必须是 100% 100%**，不是"逗号数 = 1"。
    //   《50》§4.1 原文写的是后者，而它取不到那件事：background-size 的 computed 值是**每层一个**，
    //   只声明一组时浏览器按列表循环复用 ⇒ 同样序列化成 "600% 400%, 600% 400%"，逗号照样 1 个。
    //   （红检实测：把声明改成一组，逗号数判据仍然绿 —— 那正是 §1.6 记录的陷阱本身。）
    check('LL-37-两组尺寸', two.size === '600% 400%, 100% 100%',
      `backgroundSize="${two.size}"（第二层必须是 100% 100%；复用了第一组就是字牌被放大 6 倍）`);
    // 同上：position 漏一组时第二层会拿到第一层的 calc，字牌被推到格子外面去。
    check('LL-37-两组定位', /,\s*0px 0px$/.test(two.pos),
      `backgroundPosition="${two.pos}"（第二层应固定在 0px 0px）`);
    // 正面锚：`--fb` 真的挂在这一格上了。否则上面那句可能只是"第二个 url 恰好是别的什么"。
    check('LL-37-字牌变量已挂', two.fb.includes('data:image/svg+xml') && two.fb.length > 100,
      `--fb 长度 ${two.fb.length}（应 >100 且含 data:image/svg+xml；空值等于字牌层没有内容）`);
    check('LL-37-字牌类', /\bllk-face-\d+\b/.test(two.cls),
      `格子类里应有 llk-face-N（实际 "${two.cls}"）`);

    // 降级段：拦掉 sprite ⇒ JS 判 fallback ⇒ .llk-no-sprite 把两层收成一层字牌图。
    await page.route('**/Images/llk/faces.png', r => r.abort().catch(() => {}));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(
      () => page.getAttribute('.llk-board', 'data-llk-sprite'),
      { timeout: 12_000, intervals: [100, 200, 500, 1000] },
    ).toBe('fallback');

    const one = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.llk-cell[data-idx="0"]'));
      return { bg: cs.backgroundImage, size: cs.backgroundSize };
    });
    check('LL-37-只剩字牌层', !one.bg.includes('faces.png') && one.bg.includes('data:image/svg+xml'),
      `降级后应只剩字牌图（实际 "${one.bg.slice(0, 70)}…"）；若为 none 说明改回了 background-image: none`);
    check('LL-37-字牌铺满', one.size === '100% 100%', `降级后 backgroundSize="${one.size}"（应 100% 100%）`);
  });
});

// ───── H-018 / C-95+C-96：关卡日历（/llkcalendar）与服务端每日榜 ─────
// 数据目录接缝：由 playwright.config.mjs 的 `webServer.env: { Lianliankan__DataDir: … }` 注入。
// 这里按同一个 `path.join(os.tmpdir(), 'jtjsym-e2e-llk')` 自己算一遍，**不 import config** ——
// 两处算的是同一个字符串，靠这条注释互相指向。
// ⚠ 绝不能改成 `tools/e2e/.tmp/…`：FT-53 的豁免正则只认 `functiontest.mjs` 与 `.workbuddy/`，
//   而 `.gitignore` 没有 `.tmp/` ⇒ 跑完 e2e 会留下未跟踪文件 ⇒ FT-53 判红（《51》§1.3）。
const LLK_DATA_DIR = path.join(os.tmpdir(), 'jtjsym-e2e-llk');
const LLK_DATA_FILE = path.join(LLK_DATA_DIR, 'llk-records.json');

test.describe('关卡日历与服务端榜单（H-018）', () => {
  // 本轮从空榜开始：否则"无纪录格显示 —"和"提交后出现名字"都会受上一次运行的残留影响。
  // 服务端有进程内缓存，所以真跑门禁时应是**新起的**实例（webServer 会起；复用人工实例时
  // LL-39 的落盘断言会把这件事说出来）。
  test.beforeAll(() => {
    fs.rmSync(LLK_DATA_DIR, { recursive: true, force: true });
  });

  test('LL-38 日历渲染：42 槽位、未来格禁用、无纪录格显示「—」（H-018 / C-95）', async ({ page }) => {
    const TODAY = todayIssue();
    const Y = Math.floor(TODAY / 10000);
    const M = Math.floor(TODAY / 100) % 100;

    await open(page, '/llkcalendar', 1200);

    const g = await page.evaluate(today => {
      const grid = document.querySelector('.llk-cal-grid');
      const cells = [...document.querySelectorAll('.llk-cal-cell')];
      const sec = el => el.querySelector('.llk-cal-sec').textContent.trim();
      const name = el => el.querySelector('.llk-cal-name').textContent.trim();
      const navs = [...document.querySelectorAll('.llk-cal-nav')];
      // 「无纪录」的样本格：**按当前渲染结果挑一个空格**，不写死"当月 1 号"。
      // 服务端有进程内缓存，同一台站上跑第二遍时 1 号可能已被上一遍写过（LL-39），
      // 写死下标会把"缓存残留"误报成"日历渲染坏了"。
      const free = cells.find(el => !el.disabled && (el.dataset.sec ?? '') === '');
      return {
        slots: grid ? grid.children.length : -1,
        cells: cells.length,
        blanks: document.querySelectorAll('.llk-cal-blank').length,
        title: document.querySelector('.llk-cal-title')?.textContent.trim(),
        week: [...document.querySelectorAll('.llk-cal-week span')].map(s => s.textContent.trim()).join(''),
        future: cells.filter(c => Number(c.dataset.issue) > today).map(c => c.disabled),
        past: cells.filter(c => Number(c.dataset.issue) <= today).map(c => c.disabled),
        freeIssue: free ? Number(free.dataset.issue) : 0,
        freeSec: free ? sec(free) : '(无空格)',
        freeThird: free ? name(free) : '(无空格)',
        freeAria: free ? free.getAttribute('aria-label') : '(无空格)',
        detail: document.querySelector('.llk-cal-detail')?.textContent.trim(),
        nextDisabled: navs[1]?.disabled,
        prevDisabled: navs[0]?.disabled,
      };
    }, TODAY);

    // 42 = 6 行 × 7 列。判定槽位而不是"日期格数"：格数随月份变（28~31），槽位恒定才是"换月不跳高度"。
    check('LL-38-槽位', g.slots === 42 && g.cells + g.blanks === 42,
      `槽位=${g.slots}（日期格 ${g.cells} + 空白 ${g.blanks}）`);
    check('LL-38-星期行', g.week === '一二三四五六日', `星期行="${g.week}"`);
    check('LL-38-月份标题', g.title === `${Y}年${M}月`, `标题="${g.title}"（应 ${Y}年${M}月，首屏落在当前月）`);
    check('LL-38-未来格禁用', g.future.length > 0 && g.future.every(Boolean),
      `未来格 ${g.future.length} 个，其中可点的 ${g.future.filter(v => !v).length} 个`);
    check('LL-38-历史格可点', g.past.every(v => !v), `历史/今天共 ${g.past.length} 个，禁用的 ${g.past.filter(Boolean).length} 个`);
    // 三级状态的第一级：无人通关 = 第 2 行「—」、第 3 行留空（不是「神秘嘉宾」—— 那是"通关未留名"）
    check('LL-38-无纪录两行', g.freeIssue > 0 && g.freeSec === '—' && g.freeThird === '',
      `空格（期号 ${g.freeIssue || '无'}）：第 2 行="${g.freeSec}" 第 3 行="${g.freeThird}"`);
    check('LL-38-无纪录aria', g.freeIssue > 0
      && g.freeAria === `${Math.floor(g.freeIssue / 100) % 100}月${g.freeIssue % 100}日 无人通关`,
      `aria-label="${g.freeAria}"（期号 ${g.freeIssue}；本月所有可玩格都已有纪录时这里会报「无空格」）`);
    check('LL-38-详情条默认', g.detail === '点格子进关', `详情条="${g.detail}"`);
    check('LL-38-下个月禁用', g.nextDisabled === true, `当前月时「下个月」disabled=${g.nextDisabled}`);

    // 上个月：**只在第一个月（2026年11月）禁用**。用例不写死"当前是哪个月"——
    // 跑测日期一变，硬写就会变成"在 12 月也要求上个月禁用"这种假红。
    const prev = page.locator('.llk-cal-nav').first();
    if (await prev.isDisabled()) {
      check('LL-38-月份边界', g.title === '2026年11月',
        `「上个月」被禁用，但当前是 ${g.title}（应只在 2026年11月 禁用）`);
    } else {
      await prev.click();
      await expect.poll(() => page.textContent('.llk-cal-title'), { timeout: 5000 }).not.toBe(g.title);
      const slots2 = await page.evaluate(() => document.querySelector('.llk-cal-grid').children.length);
      check('LL-38-换月恒 42 槽', slots2 === 42, `换月后槽位=${slots2}`);
    }
  });

  test('LL-39 提交流程：通关 → 留名 → 日历上出现名字（H-018 / C-95）', async ({ page }) => {
    // ⚠ 期号**不能写死**（原来写 20261105，第二轮起必红）。踩的是"删了目录、删不掉进程内缓存"：
    //   `beforeAll` 删的是磁盘目录，而 `LianliankanLeaderboard` 的 `_cache` 在**第一次读**之后就再也不看盘
    //   ⇒ 同一个服务进程里跑第二遍时，缓存里还留着上一遍写的 `{20261105: 5s}`，而这一遍注入的也是 5 秒
    //   ⇒ `sec >= current.Sec` 判"不够快" ⇒ 提交被拒 ⇒ 落盘断言和「已记入榜单」一起红，
    //   而红的样子（什么都没写）与"接缝没生效"一模一样，属最难查的一类。
    //   实测：同一台站上连跑两遍 llk spec，第一遍绿、第二遍红。
    // 修法：**先问服务端**（渲染出来的日历就是缓存的样子）哪一天还没有纪录，再拿那一天做提交。
    //   这样无论跑第几遍都能拿到一个"缓存里确实没有"的期号，提交必然被采纳。
    await page.goto('/llkcalendar', { waitUntil: 'domcontentloaded' });
    const free = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.llk-cal-cell')]
        .find(el => !el.disabled && (el.dataset.sec ?? '') === '');   // 无纪录的格子：第 2 行是「—」
      return c ? Number(c.dataset.issue) : 0;
    });
    check('LL-39-选到空档', free > 0 && free <= todayIssue(),
      `没找到无纪录的可玩格（${free}）—— 日历上全是纪录？本月的格子被跑满了，用例需要换月取样`);
    const ISSUE = free || 20261105;                       // 兜底只为"下面的断言能跑完并留下可读的失败"
    const MM = Math.floor(ISSUE / 100) % 100;
    const DD = ISSUE % 100;

    // 相邻同脸 = 0 拐可连 ⇒ 两下点完就通关。走的是真实交互，不是替身。
    const board = cellsWith([[idx(0, 0), 1], [idx(0, 1), 1]]);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(([rk, sk, v]) => {
      localStorage.setItem(rk, '1');                       // 挡玩法遮罩
      sessionStorage.setItem(sk, v);
    }, ['jtjsym.llk.rulesSeen', SK, JSON.stringify({ v: 1, issue: ISSUE, cells: board, elapsedSec: 5 })]);

    await page.goto(`/lianliankan?issue=${ISSUE}`, { waitUntil: 'domcontentloaded' });
    // 正面锚：恢复提示条。不用"盘面像不像"——每日真实盘也可能长这样，那会假绿。
    await expect.poll(() => page.locator('.llk-resume-tip').count(), { timeout: 12_000 }).toBe(1);

    await page.locator('.llk-cell[data-idx="0"]').click();
    await expect.poll(() => page.locator('.llk-cell.is-selected').count(), { timeout: 5_000 }).toBe(1);
    await page.locator('.llk-cell[data-idx="1"]').click();
    await expect.poll(() => page.locator('.llk-overlay-title').textContent(), { timeout: 5_000 }).toBe('全部消除');

    await page.locator('.llk-name-input').fill('测试者');
    await page.locator('.llk-name-btn').click();
    await expect.poll(() => page.locator('.llk-name-saved').textContent(), { timeout: 8_000 })
      .toBe('已记入榜单');

    // 落盘断言放在**看日历之前**：文件不在 ⇒ 直接说"当前实例用的不是 e2e 数据目录"，
    // 而不是让下一条"日历上没有名字"莫名其妙地红。
    check('LL-39-落盘', fs.existsSync(LLK_DATA_FILE),
      `榜单文件不在 ${LLK_DATA_FILE}（webServer.env 没生效？或复用了手工起的实例）`);
    const raw = fs.existsSync(LLK_DATA_FILE) ? fs.readFileSync(LLK_DATA_FILE, 'utf8') : '';
    check('LL-39-内容', raw.includes(String(ISSUE)) && raw.includes('测试者'),
      `文件内容="${raw.slice(0, 200)}"`);

    await page.goto('/llkcalendar', { waitUntil: 'domcontentloaded' });
    await expect(page.locator(`.llk-cal-cell[data-issue="${ISSUE}"] .llk-cal-name`))
      .toHaveText('测试者', { timeout: 8_000 });

    const cell = await page.evaluate(i => {
      const c = document.querySelector(`.llk-cal-cell[data-issue="${i}"]`);
      return {
        sec: c.querySelector('.llk-cal-sec').textContent.trim(),
        name: c.querySelector('.llk-cal-name').textContent.trim(),
        third: c.getAttribute('aria-label'),
      };
    }, ISSUE);

    // 秒数是**比较**不是等值：通关用时受机器速度影响（这里是注入的 5 秒 + 若干时钟拍）
    check('LL-39-秒数', /^\d+秒$/.test(cell.sec), `第 2 行="${cell.sec}"（应 \\d+秒）`);
    check('LL-39-名字', cell.name === '测试者', `第 3 行="${cell.name}"`);
    check('LL-39-aria全名', cell.third === `${MM}月${DD}日 ${cell.sec.replace('秒', '')}秒 测试者`,
      `aria-label="${cell.third}"（应 ${MM}月${DD}日 … 测试者，期号 ${ISSUE}）`);
  });

  test('LL-40 旧关复玩：?issue= 让 TryFrom 按所选期号恢复（H-018 / C-95）', async ({ page }) => {
    const ISSUE = 20261105;
    // 只贴两组角（2 个头像各 2 张，过成对闸）⇒ 48 格在场时一眼看出"没恢复"
    const board = cellsWith([[idx(0, 0), 1], [idx(0, 1), 1], [idx(7, 4), 2], [idx(7, 5), 2]]);

    await page.goto(`/lianliankan?issue=${ISSUE}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(([rk, sk, v]) => {
      localStorage.setItem(rk, '1');
      sessionStorage.setItem(sk, v);
    }, ['jtjsym.llk.rulesSeen', SK, JSON.stringify({ v: 1, issue: ISSUE, cells: board, elapsedSec: 5 })]);

    // 刷新：URL（含 ?issue=）不变 ⇒ OnInitialized 重新解析 query。
    // ⚠ 这就是 `?issue=` **唯一**支持的进入方式：跨页进入（或刷新）。
    //   页内 `NavigateTo("/lianliankan?issue=…")` 是同路由，组件不重建、OnInitialized 不再跑，
    //   期号会静默不变。将来要做"下一关"必须先把它提成路由参数（@page "/lianliankan/{Issue:int}"）。
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.locator('h1')).toHaveText('地球日20261105关', { timeout: 8_000 });
    await expect.poll(() => page.locator('.llk-resume-tip').count(), { timeout: 12_000 }).toBe(1);

    const live = await page.evaluate(() => [...document.querySelectorAll('.llk-cell')]
      .map(c => Number(c.getAttribute('data-face'))).filter(v => v !== 0).length);
    // 若 TryFrom 还是拿"今天"当期望期号 ⇒ 期号闸丢弃这份档 ⇒ 回落真实每日盘 ⇒ 48 块
    check('LL-40-恢复', live === 4,
      `恢复后在场 ${live} 块（应 4；48 = TryFrom 用了今天的期号，把这份档整档丢了）`);
    check('LL-40-期号', (await page.textContent('h1')).includes('20261105'),
      `标题="${(await page.textContent('h1')).trim()}"`);
  });

  test('LL-41 320×568 日历布局：格宽 ≥40、无横向滚动、三行不溢出（H-018 / C-95）', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    const mp = await ctx.newPage();
    await open(mp, '/llkcalendar', 1200);

    const m = await mp.evaluate(() => {
      const cell = document.querySelector('.llk-cal-cell');
      const r = cell.getBoundingClientRect();
      return {
        w: r.width,
        h: r.height,
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      };
    });

    check('LL-41-格宽', m.w >= 40,
      `格宽 ${m.w.toFixed(2)}px（应 ≥40；窄于此 3 字名 27px + 左右留白就挤）`);
    check('LL-41-无横向滚动', m.sw <= m.cw, `scrollWidth=${m.sw} > clientWidth=${m.cw}`);
    check('LL-41-格高', m.h >= 38, `格高 ${m.h.toFixed(2)}px（应 ≥38）`);

    // 最坏文本能否装下：把「123秒 + 3 字名」临时写进一格再量，量完还原。
    // ⚠ 不用真实数据：这条不该依赖 LL-39 是否跑过，而"数据里恰好没有名字"会让判据恒绿。
    //   ——这是**刻意的 DOM 探针**，测的是版式预算，不是数据。
    const fit = await mp.evaluate(() => {
      const cell = document.querySelector('.llk-cal-cell');
      const sec = cell.querySelector('.llk-cal-sec');
      const name = cell.querySelector('.llk-cal-name');
      const before = { sec: sec.textContent, name: name.textContent };
      sec.textContent = '123秒';            // 9px 下 24.84px（三行里最宽的一行）
      name.textContent = '魏老夫';           // 3 字 27px = CalName 的显示上限
      const out = {
        secW: sec.scrollWidth,
        nameClip: name.scrollWidth - name.clientWidth,   // >0 = 名字被裁掉了
        vOver: cell.scrollHeight - cell.clientHeight,    // >0 = 三行装不下（折行或溢出）
        cellW: cell.clientWidth,
      };
      sec.textContent = before.sec;
      name.textContent = before.name;
      return out;
    });
    await ctx.close();

    check('LL-41-秒数单行', fit.secW <= fit.cellW + 1, `123秒 宽 ${fit.secW}px，格内可用 ${fit.cellW}px`);
    check('LL-41-名字不裁', fit.nameClip <= 0, `3 字名被裁 ${fit.nameClip}px`);
    check('LL-41-纵向不溢', fit.vOver <= 0, `三行比格子高 ${fit.vOver}px`);
  });

  test('LL-42 提交失败有反馈：数据目录不可写时出现失败文案（D-40 / C-98）', async ({ page }) => {
    // 构造手法：**运行期把数据目录换成同名文件**（不是用 Lianliankan__DataDir 起新站点）。
    // 为什么不换 env：`reuseExistingServer: true` ⇒ 站点已在 14074 跑着时 `webServer.env` 一个字都不生效
    //   （H-018 批 C 实测过：手工实例指向 E:/tmp/llk-pr-data，LL-39 因此假红一轮）。
    //   `_dir` 是文件 ⇒ `SaveAsync` 第一行的 `Directory.CreateDirectory` 必抛 IOException（实测），
    //   而读路径 `File.Exists(文件/子文件)` = false ⇒ 空榜、不抛 ⇒ 日历还能正常渲染，
    //   正好把"只有提交这条路失败"隔出来。
    // ⚠ 期号必须挑一个**服务端缓存里没有纪录**的日子：有纪录时 SubmitAsync 会先返回 null（不够快），
    //   走的是灰字分支，断言失败文案就会变成假红。
    await page.goto('/llkcalendar', { waitUntil: 'domcontentloaded' });
    const free = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.llk-cal-cell')]
        .find(el => !el.disabled && (el.dataset.sec ?? '') === '');
      return c ? Number(c.dataset.issue) : 0;
    });
    check('LL-42-选到空档', free > 0, `没找到无纪录的可玩格（${free}）—— 本月被跑满了，用例需要换月取样`);
    const ISSUE = free || 20261105;

    const board = cellsWith([[idx(0, 0), 1], [idx(0, 1), 1]]);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(([rk, sk, v]) => {
      localStorage.setItem(rk, '1');
      sessionStorage.setItem(sk, v);
    }, ['jtjsym.llk.rulesSeen', SK, JSON.stringify({ v: 1, issue: ISSUE, cells: board, elapsedSec: 5 })]);

    await page.goto(`/lianliankan?issue=${ISSUE}`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => page.locator('.llk-resume-tip').count(), { timeout: 12_000 }).toBe(1);

    // 通关（走真实交互）
    await page.locator('.llk-cell[data-idx="0"]').click();
    await expect.poll(() => page.locator('.llk-cell.is-selected').count(), { timeout: 5_000 }).toBe(1);
    await page.locator('.llk-cell[data-idx="1"]').click();
    await expect.poll(() => page.locator('.llk-overlay-title').textContent(), { timeout: 5_000 }).toBe('全部消除');

    // 换脸：目录 → 文件
    fs.rmSync(LLK_DATA_DIR, { recursive: true, force: true });
    fs.writeFileSync(LLK_DATA_DIR, 'x');
    try {
      await page.locator('.llk-name-input').fill('失败者');
      await page.locator('.llk-name-btn').click();

      await expect.poll(() => page.locator('.llk-name-error').count(), { timeout: 8_000 }).toBe(1);
      check('LL-42-失败文案',
        (await page.textContent('.llk-name-error')).trim() === '提交失败：纪录只保存在本机',
        `文案="${(await page.textContent('.llk-name-error')).trim()}"`);

      // 可重试：按钮还在、没被禁用、也没换成「已记入榜单」
      const retry = await page.evaluate(() => ({
        btn: document.querySelectorAll('.llk-name-btn').length,
        disabled: document.querySelector('.llk-name-btn')?.disabled,
        saved: document.querySelectorAll('.llk-name-saved').length,
        input: document.querySelectorAll('.llk-name-input').length,
      }));
      check('LL-42-可重试', retry.btn === 1 && retry.disabled === false && retry.saved === 0 && retry.input === 1,
        `按钮 ${retry.btn} 个 disabled=${retry.disabled}、已保存 ${retry.saved}、输入框 ${retry.input}`);

      // 日历徽标：同一次失败已经把 LastProbe 置成 io，日历页**只读内存**就该显示出来
      await page.goto('/llkcalendar', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => page.locator('.llk-cal-badge').count(), { timeout: 8_000 }).toBe(1);
      check('LL-42-徽标', (await page.textContent('.llk-cal-badge')).trim() === '榜单暂时不可用（IO）',
        `徽标="${(await page.textContent('.llk-cal-badge')).trim()}"`);
    } finally {
      // 必须恢复：workers:1 且同 spec 内顺序执行，污染会让后续任何一条读写都用不了这个目录
      fs.rmSync(LLK_DATA_DIR, { force: true });
      fs.mkdirSync(LLK_DATA_DIR, { recursive: true });
    }
  });
});

// ───── P-077 / C-82：reduced-motion 下重排必须"只换盘、不播动画" ─────
// **本用例是守卫，不是证明修复**：短路现在就是对的（页面 :744/:745 把两个时长压 0，
// llkshuffle.js:23 再早退一层），这条防的是"以后有人把某一层拆掉"。
//
// 判据 = 三个"零" + 一条功能锚：
//   ① script transform 动画格峰值 = 0 —— 判别式必须是 `instanceof Animation && !CSSTransition && !CSSAnimation`。
//      只数"有 transform 动画"会恒绿：44 个 is-gone 格自带 88 个带 transform 的 CSSTransition
//      （第 11 版红检 6 实测 anyTransform=44，关掉 FLIP 照样过）。
//   ② is-shuffle-fly 峰值 = 0 —— JS 侧没起播的正面锚（该 class 只由 playShuffle 加）。
//   ③ is-shuffle-in 峰值 = 0 —— **唯一能把红检锚到页面 shuffleInMs = 0 那一行的判据**；
//      没有它，①②都只指向 JS 层，删掉页面的 0 短路也不会红。
//   ④ 功能锚：重排真跑完了（face 序列变了 + 还能消一对）。
//      **不要**用 data-llk-reshuffling：reduced-motion 下它 0/122 次采样出现（从未进 DOM）——
//      两个 Task.Delay 都被跳过 ⇒ isReshuffling true→false 之间没有任何 await ⇒ Blazor 合并成一次渲染，
//      页面 :857 的注释原文就是"reduced-motion 时反而故意让它合并"。
//
// "0 个动画"是负命题、没有可观测完成信号 ⇒ 只能"固定时间窗内全程为 0"。
// 窗口 1500ms（no-preference 下 busy 窗口约 600ms），10ms 采样，**在页面内一次 evaluate 里循环**：
// 每 10ms 往返一次 CDP，往返本身就把采样周期撑到 30ms+。
//
// ⚠ 不能用 openLlk / openWithStorage：它们内含 sleep(1100~1600) 沉降，等它们返回时重排早跑完，
//   采样起点落在窗口之后 ⇒ 负命题**恒绿**（"漏掉窗口"的经典假绿）。必须裸 goto。
test.describe('reduced-motion 降级', () => {
  // test.use 只作用于本 describe：其余 LL 用例仍是默认 no-preference。
  test.use({ reducedMotion: 'reduce' });

  test('LL-32 reduced-motion 下重排只换盘不播动画：FLIP 与淡入淡出全部短路（P-077）', async ({ page }) => {
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(e.message));

    // 与 LL-21 / LL-31 同一张贴角死局档：4 块、过成对闸、原样是死局 ⇒ Reshuffle 必然换脸。
    const dead = cellsWith([
      [idx(0, 0), 1], [idx(0, 1), 2],
      [idx(1, 0), 2], [idx(1, 1), 1],
    ]);
    // 先走首页写两处存储（rulesSeen 挡玩法遮罩、session 注入死局盘），再进目标页。
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(([rk, sk, v]) => {
      localStorage.setItem(rk, '1');
      sessionStorage.setItem(sk, v);
    }, ['jtjsym.llk.rulesSeen', SK, JSON.stringify({ v: 1, issue: todayIssue(), cells: dead, elapsedSec: 5 })]);

    // 导航后立刻起采样：evaluate 的首个动作即开始循环，中间不 sleep。
    await page.goto('/lianliankan', { waitUntil: 'domcontentloaded' });
    const peak = await page.evaluate(() => new Promise(resolve => {
      const t0 = performance.now();
      const isScript = a =>
        typeof Animation !== 'undefined' && a instanceof Animation &&
        !(typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) &&
        !(typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation);
      let peakScript = 0, peakFly = 0, peakP2 = 0, ticks = 0;
      const tick = () => {
        ticks++;
        let sc = 0, fly = 0, p2 = 0;
        for (const el of document.querySelectorAll('.llk-cell')) {
          if (el.classList.contains('is-shuffle-fly')) fly++;
          if (el.classList.contains('is-shuffle-in')) p2++;
          if (el.getAnimations().some(a => isScript(a) &&
            (a.effect?.getKeyframes?.() ?? []).some(k => 'transform' in k))) sc++;
        }
        if (sc > peakScript) peakScript = sc;
        if (fly > peakFly) peakFly = fly;
        if (p2 > peakP2) peakP2 = p2;
        if (performance.now() - t0 < 1500) setTimeout(tick, 10);
        else resolve({ peakScript, peakFly, peakP2, ticks });
      };
      tick();
    }));

    // 先证明"采样真的跑了"：负命题最怕的是"窗口没盖到、全程读到 0"。
    check('LL-32-采样覆盖', peak.ticks >= 100,
      `${peak.ticks} 次采样 / 1500ms（<100 说明主线程被阻塞或窗口落空，本用例的"零"不可信）`);
    check('LL-32-script动画', peak.peakScript === 0,
      `峰值 ${peak.peakScript} 个格在播 script transform 动画（应 0；判别式已排除 CSSTransition / CSSAnimation）`);
    check('LL-32-飞行class', peak.peakFly === 0, `is-shuffle-fly 峰值 ${peak.peakFly}（应 0：playShuffle 不该被调用）`);
    check('LL-32-淡入class', peak.peakP2 === 0, `is-shuffle-in 峰值 ${peak.peakP2}（应 0：页面的 shuffleInMs = 0 短路生效）`);

    // 功能锚：盘面确实换了脸 —— 否则"动画没播"可能只是"重排根本没发生"。
    const after = await readCells(page);
    check('LL-32-盘已换脸', JSON.stringify(after) !== JSON.stringify(dead),
      `重排后 ${after.filter(v => v > 0).length} 块；序列应与注入时不同（原样是死局，Reshuffle 不会停在那里）`);
    check('LL-32-可消', await eliminateAnyPair(page), '重排后两两试过都没消掉（说明不是合法可解盘）');
    check('LL-32-无console报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  });
});
