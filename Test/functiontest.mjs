// 夜游桃花源（jtjsym）自研功能测试 / function test
//
// 定位：不复用《07-测试文档-全量测试用例》与 tools/e2e 的既有用例。
//       全部由源码审查驱动，覆盖「数据结构合法性、异步生命周期竞态、浏览器存储语义边界、
//       独立实现反算、跨模块回归、工程静态事实」——即既有套件没有断言过的面。
//
// 运行前提：
//   1) 站点已启动（建议独立于调试实例，避免旧 IL）：
//      dotnet run -c Release --no-launch-profile --environment Development --urls http://localhost:14075
//   2) tools/e2e/node_modules 已安装（本文件直接复用其中的 @playwright/test，不新增依赖）
//   3) node Test/functiontest.mjs [--base http://localhost:14075] [--only FT-01,FT-07] [--json <path>]
//
// 判定口径：
//   PASS / FAIL = 与「标准 2048 规则 + 数据完整性 + 代码自身声明的语义」比对；
//   INFO        = 只记录事实与现象，不判对错（用户要求：现象、技术要点一律登记）。
//   每条用例自带独立预期与证据，失败不中断其余用例。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(pathToFileURL(path.join(ROOT, 'tools/e2e/package.json')).href);
const { chromium } = require('@playwright/test');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = arg('--base', 'http://localhost:14075');
const ONLY = arg('--only', '').split(',').map(s => s.trim()).filter(Boolean);
const JSON_OUT = arg('--json', '');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEY = 'jtjsym.g2048.session';
const BEST = 'jtjsym.g2048.best';

// ───────────────────────── 通用 DOM / 存储读取 ─────────────────────────
const readState = page => page.evaluate(() => ({
  tiles: [...document.querySelectorAll('.game-container .tile')].map(t => t.textContent.trim()),
  score: ([...document.querySelectorAll('p')].map(p => p.textContent.trim()).find(t => t.startsWith('分数')) || null),
  best: document.querySelector('p.best-score')?.textContent.trim() || null,
  over: !!document.querySelector('.game-over'),
  disabled: [...document.querySelectorAll('.controls fluent-button')].map(b => b.disabled),
  classes: [...document.querySelectorAll('.game-container .tile')].map(t => t.className),
}));
const readStore = page => page.evaluate(([k, b]) => ({ session: sessionStorage.getItem(k), best: localStorage.getItem(b) }), [KEY, BEST]);
const scoreOf = s => parseInt(/(-?\d+)/.exec(s.score || '')?.[1] ?? 'NaN', 10);
const bestOf = s => parseInt(/(-?\d+)/.exec(s.best || '')?.[1] ?? 'NaN', 10);
const nonEmpty = s => s.tiles.filter(Boolean).length;
const grid = (arr, score = 0) => ({ v: 1, cells: arr, score });

async function fresh(browser, viewport = { width: 1400, height: 1000 }, init) {
  const ctx = await browser.newContext({ viewport, baseURL: BASE });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  return { ctx, page, errs };
}
async function open(page, url, settle = 1400) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(settle);
}
async function seedAndReload(page, payload) {
  await open(page, '/game_2048', 900);
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v),
    [KEY, typeof payload === 'string' ? payload : JSON.stringify(payload)]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(1100);
}
const clickDir = async (page, dir, wait = 300) => {
  const sel = { up: '⬆️', left: '⬅️', down: '⬇️', right: '➡️' }[dir];
  await page.locator(`.controls fluent-button:has-text("${sel}")`).click();
  await sleep(wait);
};

// 独立实现的标准 2048（只用于挑「必然有效」方向与算理论分数增量，不参与页面逻辑）
function moveLine(line) {
  const v = line.filter(x => x !== 0), o = [];
  let i = 0, gain = 0;
  while (i < v.length) {
    if (i + 1 < v.length && v[i] === v[i + 1]) { o.push(v[i] * 2); gain += v[i] * 2; i += 2; }
    else { o.push(v[i]); i++; }
  }
  while (o.length < 4) o.push(0);
  return { out: o, gain };
}
function sim(b, dir) {
  let gain = 0;
  const apply = lines => lines.map(l => { const r = moveLine(l); gain += r.gain; return r.out; });
  if (dir === 'left') return { board: apply(b), gain };
  if (dir === 'right') return { board: apply(b.map(r => [...r].reverse())).map(r => r.reverse()), gain };
  if (dir === 'up') {
    const c = [0, 1, 2, 3].map(k => b.map(r => r[k])), m = apply(c);
    return { board: b.map((r, i) => r.map((_, k) => m[k][i])), gain };
  }
  const c = [0, 1, 2, 3].map(k => b.map(r => r[k]).reverse()), m = apply(c);
  return { board: b.map((r, i) => r.map((_, k) => m[k][3 - i])), gain };
}
const boardOf = s => {
  const f = s.tiles.map(t => parseInt(t, 10) || 0);
  return [0, 1, 2, 3].map(r => f.slice(r * 4, r * 4 + 4));
};

// 独立实现的日历逐级扣减（对照 D-03 的 CalendarElapsed，不抄页面代码）
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
function addYears(d, n) {
  const y = d.getFullYear() + n, m = d.getMonth() + 1;
  return new Date(y, m - 1, Math.min(d.getDate(), daysInMonth(y, m)), 0, 0, 0);
}
function addMonths(d, n) {
  const t = d.getFullYear() * 12 + d.getMonth() + n, y = Math.floor(t / 12), m = t % 12 + 1;
  return new Date(y, m - 1, Math.min(d.getDate(), daysInMonth(y, m)), 0, 0, 0);
}
function calendarElapsed(anchor, now) {
  if (now < anchor) return [0, 0, 0];
  let y = now.getFullYear() - anchor.getFullYear(), t = addYears(anchor, y);
  if (t > now) { y--; t = addYears(anchor, y); }
  let m = (now.getFullYear() - t.getFullYear()) * 12 + now.getMonth() - t.getMonth();
  let t2 = addMonths(t, m);
  if (t2 > now) { m--; t2 = addMonths(t, m); }
  return [y, m, Math.floor((now - t2) / 86400000)];
}
function formatCalendar([y, m, d]) {
  if (y === 0 && m === 0 && d === 0) return '不到 1 天';
  const parts = [];
  if (y > 0) parts.push(`${y} 年${m === 0 && d === 0 ? '整' : ''}`);
  if (m > 0) parts.push(`${m} 个月`);
  if (d > 0) parts.push(`${d} 天`);
  return parts.join(' ');
}

// ───────────────────────── 用例注册与运行器 ─────────────────────────
const CASES = [];
const ft = (id, group, name, fn) => CASES.push({ id, group, name, fn });

// ═══════════════ A 组：D-17 对局进度会话保持（新功能，重点） ═══════════════
ft('FT-01', 'D-17', '存档内容合法性：只校验 v 与 cells 长度之外的取值', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const cases = [
    ['负分', grid([2, 4, ...Array(14).fill(0)], -5)],
    ['非 2 幂块', grid([3, 3, 6, 7, ...Array(12).fill(0)], 0)],
    ['全空盘', grid(Array(16).fill(0), 0)],
    ['超大值', grid([2147483647, 2, ...Array(14).fill(0)], 0)],
    ['伪造高分', grid([2, 4, ...Array(14).fill(0)], 999999)],
  ];
  const rows = [];
  for (const [name, payload] of cases) {
    await seedAndReload(page, payload);
    const s = await readState(page);
    rows.push({ name, score: s.score, best: s.best, blocks: nonEmpty(s),
      values: [...new Set(s.tiles.filter(Boolean))].slice(0, 6) });
  }
  // 预期：非法内容应被拒绝并退化为标准新局（2 块、分数 0、值域仅 2/4）
  const rejected = r => r.score === '分数：0' && r.blocks === 2 && r.values.every(v => v === '2' || v === '4');
  const accepted = rows.filter(r => !rejected(r)).map(r => r.name);
  await ctx.close();
  return {
    pass: accepted.length === 0 && errs.length === 0,
    expect: '非法 cells/score 的存档应被拒绝并退化为新局（2 块 / 分数 0 / 值域 2、4）',
    actual: { rows, accepted, errors: errs.slice(0, 3) },
  };
});

ft('FT-02', 'D-17', '伪造分数经恢复写入 localStorage 最高分且跨会话持久', async browser => {
  const { ctx, page } = await fresh(browser);
  const cells = Array(16).fill(0); cells[0] = 2; cells[1] = 4;
  await seedAndReload(page, grid(cells, 999999));
  const a = await readState(page), sa = await readStore(page);
  await page.evaluate(k => sessionStorage.removeItem(k), KEY);
  await open(page, '/game_2048', 1200);
  const b = await readState(page), sb = await readStore(page);
  await ctx.close();
  return {
    pass: bestOf(a) === 0 && sb.best === null,
    expect: '伪造存档不得把最高分写进 localStorage（该键是永久存储）',
    actual: { afterRestore: { score: a.score, best: a.best, storedBest: sa.best },
      afterClearingSession: { score: b.score, best: b.best, storedBest: sb.best } },
  };
});

ft('FT-03', 'D-17', '全空盘存档导致游戏永久软锁（四方向均无法产生新块）', async browser => {
  const { ctx, page } = await fresh(browser);
  await seedAndReload(page, grid(Array(16).fill(0), 0));
  const before = await readState(page);
  for (const d of ['left', 'right', 'up', 'down']) await clickDir(page, d);
  const after = await readState(page);
  await ctx.close();
  return {
    pass: nonEmpty(before) >= 2 || nonEmpty(after) >= 2,
    expect: '恢复后棋盘应可继续游戏（至少 2 块，或按一次方向后能生成新块）',
    actual: { afterRestoreBlocks: nonEmpty(before), afterFourDirectionsBlocks: nonEmpty(after),
      score: after.score, over: after.over },
  };
});

ft('FT-04', 'D-17', '非法存档值进入合并：产生非 2 幂与 int 溢出负分', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const rows = [];
  await seedAndReload(page, grid([3, 3, 0, 0, ...Array(12).fill(0)], 0));
  await clickDir(page, 'left');
  let s = await readState(page);
  rows.push({ name: '3+3', values: [...new Set(s.tiles.filter(Boolean))].slice(0, 8), score: s.score, classes: [...new Set(s.classes)].slice(0, 5) });
  await seedAndReload(page, grid([2147483647, 2147483647, 0, 0, ...Array(12).fill(0)], 0));
  await clickDir(page, 'left');
  s = await readState(page);
  rows.push({ name: 'int.MaxValue*2', values: [...new Set(s.tiles.filter(Boolean))].slice(0, 8), score: s.score, classes: [...new Set(s.classes)].slice(0, 5) });
  await ctx.close();
  const all = rows.flatMap(r => r.values.map(String));
  return {
    pass: all.every(v => /^\d+$/.test(v) && (Number(v) & (Number(v) - 1)) === 0) && rows.every(r => /分数：\d+$/.test(r.score || '')),
    expect: '棋盘值恒为 2 的幂、分数恒非负（标准 2048 不变量）',
    actual: { rows, errors: errs.slice(0, 3) },
  };
});

ft('FT-05', 'D-17', '正向：死局盘面恢复后由 IsGameOver() 重算遮罩与禁用态', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const dead = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
  await seedAndReload(page, grid(dead, 1234));
  const s = await readState(page), st = await readStore(page);
  await ctx.close();
  return {
    pass: s.over && s.disabled.every(Boolean) && !/"isGameOver"/.test(st.session || ''),
    expect: '存档不含 isGameOver，恢复后应自动出遮罩且四个方向按钮禁用',
    actual: { over: s.over, disabled: s.disabled, score: s.score, best: s.best, archive: st.session, errors: errs.slice(0, 3) },
  };
});

ft('FT-06', 'D-17', '语义边界：window.open / 复制标签继承 sessionStorage', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  await open(page, '/game_2048', 1400);
  for (let i = 0; i < 6; i++) await clickDir(page, ['left', 'down', 'right', 'up'][i % 4], 220);
  const a = await readState(page), sa = await readStore(page);
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10000 }).catch(() => null),
    page.evaluate(() => window.open('/game_2048', '_blank')),
  ]);
  let b = null, sb = null;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await popup.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await sleep(1300);
    b = await readState(popup); sb = await readStore(popup);
  }
  // 全新 browsing context（对照）
  const p3 = await ctx.newPage();
  await open(p3, '/game_2048', 1100);
  const c = await readState(p3), sc = await readStore(p3);
  await ctx.close();
  return {
    pass: !popup || !!(b && sa.session && sb.session !== sa.session),
    expect: '按《现状/更新记录》宣称「两个标签各玩一局互不干扰」，新开的标签不应继承 A 的残局',
    actual: { a: { blocks: nonEmpty(a), score: a.score, session: sa.session },
      popup: b && { blocks: nonEmpty(b), score: b.score, session: sb.session, inherited: sb.session === sa.session },
      freshContext: { blocks: nonEmpty(c), score: c.score, session: sc.session }, errors: errs.slice(0, 3) },
    kind: 'observe',
  };
});

ft('FT-07', 'D-17', 'fire-and-forget 落盘：走子后立刻刷新是否丢失最后一步', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  // 判据必须是「16 格盘面签名」而不是分数：位移步 gain=0，只比分数会把丢档恒判成通过
  // （既有 d17 spec 也强调「往返类一律比盘面签名」，此处同理）。
  // 点击的是一个「必然改变棋盘」的方向，若刷新后盘面与点击前逐格相同，说明这一步没进存档。
  const run = async (waitDom, n) => {
    let lost = 0, total = 0, skipped = 0; const detail = [];
    await open(page, '/game_2048', 1400);
    await clickDir(page, 'left', 600);   // 先建立一份确定存在的存档
    for (let i = 0; i < n; i++) {
      const before = await readState(page);
      if (before.over) { await page.locator('.overlay-replay-btn').click(); await sleep(500); }
      const b = boardOf(before);
      const dir = ['left', 'down', 'right', 'up'].find(d => JSON.stringify(sim(b, d).board) !== JSON.stringify(b));
      if (!dir) { skipped++; continue; }
      const sel = { up: '⬆️', left: '⬅️', down: '⬇️', right: '➡️' }[dir];
      await page.locator(`.controls fluent-button:has-text("${sel}")`).click();
      if (waitDom) {
        await page.waitForFunction(sig => {
          const t = [...document.querySelectorAll('.game-container .tile')].map(x => x.textContent.trim()).join(',');
          return t && t !== sig;
        }, before.tiles.join(','), { timeout: 4000 }).catch(() => {});
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
      await sleep(800);
      const after = await readState(page);
      const sameAsBefore = JSON.stringify(after.tiles) === JSON.stringify(before.tiles);
      total++;
      if (sameAsBefore) lost++;
      detail.push({ i, dir, beforeSig: before.tiles.join(','), afterSig: after.tiles.join(','), lost: sameAsBefore });
    }
    return { total, lost, skipped, detail };
  };
  const instant = await run(false, 10);
  const afterDom = await run(true, 8);
  await ctx.close();
  return {
    pass: instant.lost === 0 && afterDom.lost === 0,
    expect: '最后一步有效移动的盘面/分数应在刷新后完整保持（D-17 的核心承诺）',
    actual: { instantReload: instant, afterDomUpdateReload: afterDom, errors: errs.slice(0, 3) },
  };
});

ft('FT-08', 'D-17', '恢复窗口竞态探测：首帧点「重玩」是否被旧档覆盖（含点击生效性自检）', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const cells = Array(16).fill(0);
  cells[0] = 8; cells[5] = 16; cells[10] = 32; cells[15] = 64;
  // 注意：observe 的 target 必须是 document（addInitScript 执行时 documentElement 可能还不存在），
  // 否则 MutationObserver.observe 会抛 "parameter 1 is not of type 'Node'"，把测试脚本自身的异常
  // 误记成产品问题。同时记录分数轨迹，用来判断这次点击是否真的到达了服务端。
  await page.addInitScript(() => {
    window.__ftTrail = [];
    window.__ftClicked = false;
    const snap = () => {
      const p = [...document.querySelectorAll('p')].find(x => x.textContent.trim().startsWith('分数'));
      const v = p && p.textContent.trim();
      if (v && window.__ftTrail[window.__ftTrail.length - 1] !== v) window.__ftTrail.push(v);
    };
    new MutationObserver(snap).observe(document, { childList: true, subtree: true, characterData: true });
    const tick = () => {
      if (!window.__ftClicked && window.Blazor) {
        const b = document.querySelector('.replay-btn');
        if (b) { window.__ftClicked = true; b.click(); }
      }
      if (!window.__ftClicked) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const results = [];
  for (let i = 0; i < 5; i++) {
    await open(page, '/game_2048', 700);
    await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [KEY, JSON.stringify(grid(cells, 40))]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    const s = await readState(page), st = await readStore(page);
    const probe = await page.evaluate(() => ({ clicked: window.__ftClicked, trail: window.__ftTrail }));
    results.push({ i, score: s.score, blocks: nonEmpty(s), values: [...new Set(s.tiles.filter(Boolean))],
      clicked: probe.clicked, scoreTrail: probe.trail,
      archiveScore: st.session ? JSON.parse(st.session).score : null });
  }
  await ctx.close();
  const effective = results.filter(r => r.scoreTrail.includes('分数：0'));
  return {
    pass: true, kind: 'info',
    expect: '仅登记事实：首帧点击是否真正生效、分数轨迹是否被旧档回写；窗口极窄，未复现不等于不存在',
    actual: { results, clicksThatReachedServer: effective.length, errors: errs.slice(0, 3),
      note: 'isSessionReady 在读取存档前已置 true，RestartGame 会写档；恢复分支读到旧值时理论上可覆盖用户操作' },
  };
});

ft('FT-09', 'D-17', 'ServerPrerendered 首屏闪烁：预渲染新局 → 恢复残局', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const cells = Array(16).fill(0);
  [0, 3, 6, 9, 12, 15].forEach((i, k) => { cells[i] = 2 << k; });
  await seedAndReload(page, grid(cells, 88));
  const restored = await readState(page);
  // 服务端返回的预渲染 HTML 是确定性的证据
  const html = await (await fetch(BASE + '/game_2048')).text();
  const preScore = /分数：\s*(\d+)/.exec(html)?.[1] ?? null;
  const preBest = /最高分：\s*(\d+)/.exec(html)?.[1] ?? null;
  const preTiles = (html.match(/class="tile [^"]*">\d+/g) || []).length;
  await page.goto('/game_2048', { waitUntil: 'domcontentloaded' });
  const first = await readState(page);
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(1100);
  const settled = await readState(page);
  await ctx.close();
  const changed = JSON.stringify(first.tiles) !== JSON.stringify(settled.tiles) || first.score !== settled.score;
  return {
    pass: !changed,
    expect: '首屏应直接呈现恢复后的残局，不出现「新局 → 残局」的可见跳变',
    actual: { prerenderHtml: { score: preScore, best: preBest, numericTiles: preTiles },
      firstPaint: { score: first.score, best: first.best, blocks: nonEmpty(first) },
      afterRestore: { score: settled.score, best: settled.best, blocks: nonEmpty(settled) },
      restoredBefore: { score: restored.score }, changed, errors: errs.slice(0, 3) },
    kind: 'observe',
  };
});

ft('FT-10', 'D-17', '正向降级：浏览器存储 setItem 被禁时游戏仍可玩且无未处理异常', async browser => {
  const { ctx, page, errs } = await fresh(browser, { width: 1400, height: 1000 }, () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (String(k).startsWith('jtjsym.')) { const e = new Error('QuotaExceededError (simulated)'); e.name = 'QuotaExceededError'; throw e; }
      return orig.call(this, k, v);
    };
  });
  await open(page, '/game_2048', 1500);
  const initial = await readState(page);
  for (const d of ['left', 'down', 'right', 'up']) await clickDir(page, d, 260);
  const after = await readState(page);
  const st = await readStore(page);
  await ctx.close();
  return {
    pass: nonEmpty(initial) === 2 && !after.over && errs.length === 0,
    expect: '存储被禁时读失败恒 0 / 写失败静默，游戏本身零降级、控制台无未处理异常',
    actual: { initialBlocks: nonEmpty(initial), afterFourMoves: { blocks: nonEmpty(after), score: after.score, best: after.best, over: after.over },
      store: st, errors: errs.slice(0, 5) },
  };
});

// ═══════════════ B 组：D-03 日历年月天副行（新功能，重点） ═══════════════
ft('FT-11', 'D-03', '自选/恢复按钮后三行秒数的瞬时一致性', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  await open(page, '/loveTime', 1600);
  const secs = () => page.evaluate(() => [...document.querySelectorAll('div.timer')].map(t => {
    const m = /(\d+)\s*秒/.exec(t.textContent); return m ? +m[1] : null;
  }));
  let mismatch = 0; const samples = [];
  for (let i = 0; i < 12; i++) {
    await page.locator('.love-reset-bar fluent-button').nth(i % 3).click();
    const s = await secs();
    if (new Set(s).size > 1) mismatch++;
    samples.push(s);
    await sleep(110);
  }
  await ctx.close();
  return {
    pass: mismatch === 0,
    expect: '点击后三行主计时的秒数应一致（RefreshAll 一次取 DateTime.Now 的语义应扩展到事件回调）',
    actual: { mismatch, total: 12, samples, errors: errs.slice(0, 3) },
    kind: 'observe',
  };
});

ft('FT-12', 'D-03', '320px 视口：三条副行不裁切、页面不横向溢出', async browser => {
  const { ctx, page, errs } = await fresh(browser, { width: 320, height: 568 });
  await open(page, '/loveTime', 1600);
  const m = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    calendars: [...document.querySelectorAll('.timer-calendar')].map(e => ({
      text: e.textContent.trim(), sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth })),
    mainRows: [...document.querySelectorAll('.timer')].map(e => ({ sh: e.scrollHeight, ch: e.clientHeight })),
  }));
  await ctx.close();
  const overflow = m.scrollW > m.clientW;
  const clipped = m.calendars.some(c => c.sh > c.ch + 1 || c.sw > c.cw + 1) || m.mainRows.some(r => r.sh > r.ch + 1);
  return {
    pass: !overflow && !clipped && m.calendars.length === 3,
    expect: '320px（比既有 LT-30 的 375px 更窄）下三行副行完整、无横向滚动条',
    actual: { ...m, overflow, clipped, errors: errs.slice(0, 3) },
  };
});

ft('FT-13', 'D-03', '独立实现反算三行副行文案（不写死期望值）', async browser => {
  const { ctx, page } = await fresh(browser);
  await open(page, '/loveTime', 1500);
  const texts = await page.evaluate(() => [...document.querySelectorAll('.timer-calendar')].map(e => e.textContent.trim()));
  const now = new Date();
  const anchors = [new Date(2018, 3, 22), new Date(2022, 1, 25), new Date(2023, 7, 8)];
  const expected = anchors.map(a => formatCalendar(calendarElapsed(a, now)));
  // 页面在两次取时之间可能跨秒/跨天，故允许「今天」的边界差 1 天
  const rows = texts.map((t, i) => ({ line: i, actual: t, independentlyComputed: expected[i], equal: t === expected[i] }));
  await ctx.close();
  return {
    pass: rows.every(r => r.equal),
    expect: '副行文案应与 Node 侧独立实现的日历逐级扣减结果逐字一致',
    actual: { serverDate: now.toISOString(), rows },
  };
});

ft('FT-17', 'D-03', '既有 D-03 用例期望算法的时刻依赖（Math.round vs TimeSpan.Days）', async browser => {
  const { ctx, page } = await fresh(browser);
  await open(page, '/loveTime', 1500);
  const texts = await page.evaluate(() => [...document.querySelectorAll('.timer-calendar')].map(e => e.textContent.trim()));
  const now = new Date();
  const anchors = [new Date(2018, 3, 22), new Date(2022, 1, 25), new Date(2023, 7, 8)];
  // 复刻 tools/e2e/tests/d03_calendar.spec.mjs:28 的 Math.round 口径
  const roundText = a => {
    const r = calendarElapsed(a, now);
    const d = Math.round((now.getTime() - addMonths(addYears(a, r[0]), r[1]).getTime()) / 86400000);
    return formatCalendar([r[0], r[1], d]);
  };
  const rows = texts.map((t, i) => ({
    line: i, page: t,
    floorBased: formatCalendar(calendarElapsed(anchors[i], now)),
    roundBased: roundText(anchors[i]),
  }));
  await ctx.close();
  return {
    pass: true, kind: 'info',
    expect: '仅登记事实：既有 spec 的 round 口径是否与页面一致，以及当前本地时刻',
    actual: { localHour: now.getHours(), rows,
      roundMismatchCount: rows.filter(r => r.roundBased !== r.page).length,
      floorMismatchCount: rows.filter(r => r.floorBased !== r.page).length },
  };
});

// ═══════════════ C 组：其余全量功能抽查（20% 精力） ═══════════════
ft('FT-14', '全站', '320px 六条路由横向溢出', async browser => {
  const { ctx, page, errs } = await fresh(browser, { width: 320, height: 568 });
  const rows = [];
  for (const p of ['/', '/counter', '/loveTime', '/game_2048', '/tetris', '/coding_place']) {
    await open(page, p, 800);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    rows.push({ path: p, ...m, overflow: m.sw > m.cw });
  }
  await ctx.close();
  return { pass: rows.every(r => !r.overflow), expect: '六条路由在 320px 下无横向溢出', actual: { rows, errors: errs.slice(0, 3) } };
});

ft('FT-15', '全站', '路由 / 标题 / 备案链接 / 控制台异常', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const rows = [];
  for (const p of ['/', '/counter', '/loveTime', '/game_2048', '/tetris', '/coding_place', '/abc123']) {
    const resp = await page.goto(p, { waitUntil: 'domcontentloaded' });
    await sleep(420);
    rows.push({ path: p, status: resp?.status(), title: await page.title(), h1: (await page.textContent('h1').catch(() => ''))?.trim().slice(0, 24) });
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await sleep(500);
  const footer = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').includes('ICP'));
    return a ? { href: a.getAttribute('href'), text: a.textContent.trim() } : null;
  });
  await ctx.close();
  const bad = rows.filter(r => r.status !== 200 || !r.title);
  return {
    pass: bad.length === 0 && errs.length === 0,
    expect: '7 条路径全 200 且标题非空；控制台无未处理异常',
    actual: { rows, footer, errors: errs.slice(0, 5) },
    kind: 'observe',
  };
});

// ═══════════════ D 组：工程静态事实（现象 / 技术要点，只登记不判对错） ═══════════════
ft('FT-16', '静态', '工程静态事实巡检（编码 / 死代码 / 文档一致性 / CI / 已知缺陷）', async () => {
  const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const css = read('jtjsym/jtjsym/wwwroot/css/site.css');
  const cssBytes = fs.readFileSync(path.join(ROOT, 'jtjsym/jtjsym/wwwroot/css/site.css'));
  const garbled = css.split('\n').map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter(x => /[\u00c0-\u00ff]{3,}/.test(x.text)).slice(0, 6);
  const specCount = fs.readdirSync(path.join(ROOT, 'tools/e2e/tests')).filter(f => f.endsWith('.spec.mjs')).length;
  const workflows = fs.existsSync(path.join(ROOT, '.github/workflows'))
    ? fs.readdirSync(path.join(ROOT, '.github/workflows')) : [];
  const g2048 = read('jtjsym/jtjsym/Pages/MyPage/Game_2048.razor');
  const coding = read('jtjsym/jtjsym/Pages/MyPage/CodingPlace.razor');
  const tetris = read('jtjsym/jtjsym/Pages/MyPage/Tetris.razor');
  const lovetime = read('jtjsym/jtjsym/Pages/MyPage/LoveTime.razor');
  const readme = read('README.md');
  const statusDoc = read('1设计文档/1代码结构与更新记录/夜游桃花源网站技术栈与代码结构现状.md');
  const facts = {
    siteCssGarbledCommentLines: garbled,
    siteCssUtf8Decodable: (() => { try { cssBytes.toString('utf8'); return true; } catch { return false; } })(),
    e2eSpecFiles: specCount,
    statusDocSpecCountClaim: /(\d+)\s*个 spec/.exec(statusDoc)?.[1] ?? null,
    workflowFiles: workflows,
    readmeSpellings: readme.split('\n').filter(l => /Gmae|tetris|俄罗斯方块|编程挑战/.test(l)).map(l => l.trim()),
    game2048UnusedInjection: /@inject NavigationManager Navigation/.test(g2048) && !/Navigation\./.test(g2048),
    codingPlaceDeadField: /private string CodeAnswer/.test(coding) && !/@CodeAnswer/.test(coding),
    pauseDoesNotStopDifficultyTimer: /private void PauseGame\(\)[\s\S]{0,220}?gameTimer\?\.Stop\(\);/.test(tetris)
      && !/PauseGame\(\)[\s\S]{0,220}?difficultyTimer\?\.Stop\(\)/.test(tetris),
    loveTimeYearsBuiltAtInitOnly: /Enumerable\.Range\(1950, DateTime\.Now\.Year - 1949\)/.test(lovetime),
    globalDivColorRule: /div\s*\{\s*[^}]*color:\s*#886D68/.test(css),
    httpsRedirectOutsideDevGuard: /app\.UseHttpsRedirection\(\)/.test(read('jtjsym/jtjsym/Program.cs')),
  };
  return { pass: true, kind: 'info', expect: '仅登记事实', actual: facts };
});

// ───────────────────────── 执行 ─────────────────────────
const selected = ONLY.length ? CASES.filter(c => ONLY.includes(c.id)) : CASES;
const results = [];
let browser = null;
try {
  // 站点可达性预检
  const probe = await fetch(BASE + '/').then(r => r.status).catch(() => 0);
  if (probe !== 200) throw new Error(`站点不可达：${BASE}（HTTP ${probe}）。请先启动站点，或用 --base 指定地址。`);
  browser = await chromium.launch({ headless: true });
  for (const c of selected) {
    let r;
    try { r = await c.fn(browser); }
    catch (e) { r = { pass: false, kind: 'error', expect: '用例不应抛出异常', actual: { error: String(e && e.stack || e).slice(0, 500) } }; }
    const kind = r.kind || (r.pass ? 'pass' : 'fail');
    const row = { id: c.id, group: c.group, name: c.name, kind, pass: !!r.pass, expect: r.expect, actual: r.actual };
    results.push(row);
    const tag = kind === 'info' ? 'INFO' : kind === 'observe' ? (r.pass ? 'PASS' : 'OBSV') : (r.pass ? 'PASS' : 'FAIL');
    console.log(`${tag}  ${c.id}  [${c.group}] ${c.name}`);
    if (tag === 'FAIL' || tag === 'OBSV' || tag === 'INFO') console.log('       ' + JSON.stringify(r.actual).slice(0, 900));
  }
} finally {
  if (browser) await browser.close();
}
const summary = {
  base: BASE, time: new Date().toISOString(), total: results.length,
  pass: results.filter(r => r.kind === 'pass').length,
  fail: results.filter(r => r.kind === 'fail' || r.kind === 'error').length,
  observe: results.filter(r => r.kind === 'observe').length,
  info: results.filter(r => r.kind === 'info').length,
};
console.log('\n===SUMMARY=== ' + JSON.stringify(summary));
const payload = JSON.stringify({ summary, results }, null, 2);
if (JSON_OUT) { fs.writeFileSync(JSON_OUT, payload, 'utf8'); console.log('JSON -> ' + JSON_OUT); }
console.log('===RESULT===' + payload);
