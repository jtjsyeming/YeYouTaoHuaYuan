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
const readSrc = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
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
  // 18 号文档 §5.3：原 fixture 是 grid(dead, 1234)，但 16 块 2/4 的盘面 cap = 8 个 4 × 4 = 32，
  // 1234 分在这个盘面上不可能存在（内容非法），闸一上线后会被拒 → FT-05 假红。
  // 24 ≤ 32 才是"内容合法"的档，这样测到的才是"恢复 + 重算遮罩"，而不是"被拒绝后开新局"。
  await seedAndReload(page, grid(dead, 24));
  const s = await readState(page), st = await readStore(page);
  await ctx.close();
  return {
    pass: s.over && s.disabled.every(Boolean) && !/"isGameOver"/.test(st.session || ''),
    expect: '存档不含 isGameOver，恢复后应自动出遮罩且四个方向按钮禁用',
    actual: { over: s.over, disabled: s.disabled, score: s.score, best: s.best, archive: st.session, errors: errs.slice(0, 3) },
  };
});

ft('FT-06', 'D-17', '语义边界：window.open / 复制标签克隆 sessionStorage', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  await open(page, '/game_2048', 1400);
  for (let i = 0; i < 6; i++) await clickDir(page, ['left', 'down', 'right', 'up'][i % 4], 220);
  const a = await readState(page), sa = await readStore(page);
  // 隔离探针①：popup 打开前先在 A 写一个键 —— 规范规定 window.open 克隆开启者的会话存储，
  // 所以 popup 侧应当读到这个值；而克隆之后两边的写入必须互不可见（这才是与 localStorage 的真实差别）。
  await page.evaluate(() => sessionStorage.setItem('ft06.k', 'A-before'));
  const [popup] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10000 }).catch(() => null),
    page.evaluate(() => window.open('/game_2048', '_blank')),
  ]);
  let b = null, sb = null;
  const iso = {};
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await popup.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
    await sleep(1300);
    b = await readState(popup); sb = await readStore(popup);
    // 探针②：popup 读 A 的键（应为克隆快照 A-before）、写自己独有的键再回读
    Object.assign(iso, await popup.evaluate(() => {
      const popupSawA = sessionStorage.getItem('ft06.k');
      sessionStorage.setItem('ft06.k2', 'B-only');
      return { popupSawA, ownRoundTrip: sessionStorage.getItem('ft06.k2') === 'B-only' };
    }).catch(() => ({ popupSawA: 'ERR', ownRoundTrip: false })));
    // 探针③：此后 A 改写同一个键 → popup 仍应停在克隆时的 A-before；A 也不应看到 popup 的键
    await page.evaluate(() => sessionStorage.setItem('ft06.k', 'A-after'));
    iso.popupSeesLaterAWrite = await popup.evaluate(() => sessionStorage.getItem('ft06.k')).catch(() => 'ERR');
    iso.aSeesPopupKey = await page.evaluate(() => sessionStorage.getItem('ft06.k2')).catch(() => 'ERR');
  }
  // 全新 browsing context（对照）
  const p3 = await ctx.newPage();
  await open(p3, '/game_2048', 1100);
  const c = await readState(p3), sc = await readStore(p3);
  await ctx.close();
  // 判据随文档口径变更：规范行为就是"克隆"，因此"继承"才是应当成立的那一侧；
  // 并且要额外证明"继承之后各写各的"——这才是 sessionStorage 与 localStorage 的真实差别。
  const inherited = !!(sb && sa.session && sb.session === sa.session);
  const isolated =
    iso.popupSawA === 'A-before' && iso.ownRoundTrip === true &&
    iso.aSeesPopupKey === null && iso.popupSeesLaterAWrite === 'A-before';
  return {
    pass: !!popup && inherited && isolated,
    expect: 'window.open/复制标签会克隆 sessionStorage（规范行为）：新标签从同一残局开局，且此后两标签的写入互不影响',
    actual: { a: { blocks: nonEmpty(a), score: a.score, session: sa.session },
      popup: b && { blocks: nonEmpty(b), score: b.score, session: sb.session, inherited },
      isolate: iso,
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
    // 《19》判据口径变更（必须留痕）：门禁只看 afterDom。
    // 理由：instant（点完立即 reload）在任何客户端方案下都可能丢 —— 事件未必已到服务端、
    //      到了服务端 interop 也未必执行完，这是 Blazor Server 的架构边界（状态在服务端、interop 必然异步）。
    //      拿它当门禁会在物理极限上随机红（与 P-001 同型）。instant 的丢步率原样保留在 actual 里供报告引用。
    pass: afterDom.lost === 0,
    expect: '等 DOM 出现该步结果后再刷新 → 100% 保持（"渲染即已落盘"不变式）；零等待刷新仅作观测，不判红',
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
    const arch = st.session ? JSON.parse(st.session) : null;
    // 判据核心：存档与画面必须一致。点进来的瞬间重玩若被随后的恢复撤销，就会出现
    // "内存是旧残局、存档是新局"的分裂 —— 这正是 P-006 的可判别痕迹（分数轨迹看不出来：
    // 预渲染首帧本来就是"分数：0"，恢复成功也同样是 0→40）。
    const consistent = !!arch && arch.cells.join(',') === s.tiles.map(t => parseInt(t, 10) || 0).join(',')
      && String(arch.score) === String(scoreOf(s));
    results.push({ i, score: s.score, blocks: nonEmpty(s), values: [...new Set(s.tiles.filter(Boolean))],
      clicked: probe.clicked, scoreTrail: probe.trail,
      archiveScore: arch ? arch.score : null, consistent });
  }
  await ctx.close();
  return {
    // 《19》判据升级（原来是 kind:'info' + pass:true，永远只打印 INFO，不可能"转 PASS"）：
    // element.click() 绕得过 disabled / pointer-events，正好用来验证代码守卫（isRestoring）。
    // 守卫生效时：点击被忽略 → 恢复照常 → 画面=存档 → consistent；
    // 守卫失效时：RestartGame 先写新档、恢复再用旧值覆盖画面 → 两者分裂 → 必红（修复前实测 5/5）。
    pass: results.every(r => r.clicked && r.consistent),
    expect: '恢复窗口内点「重玩」不得造成"画面与存档分裂"：存档与会话存储必须逐格一致',
    actual: { results, clicksAttempted: results.filter(r => r.clicked).length,
      inconsistent: results.filter(r => !r.consistent).length, errors: errs.slice(0, 3),
      note: '守卫在 OnReplayClicked（用户入口）；RestartGame 仍被 OnInitialized 调用，故不能把守卫下沉' },
  };
});

ft('FT-09', 'D-17', 'ServerPrerendered 首屏闪烁：预渲染新局 → 恢复残局', async browser => {
  // 《19》判据改写：pass 从 !changed 换成"首帧是否带加载态"。
  // 理由：ServerPrerendered 下"不跳变"不可能达成（预渲染实例读不到 sessionStorage），
  //       加了半透明也不改变文本 → 旧判据恒 OBSV、永远不可能变好。能达成的只有"跳变前是加载态"。
  const { ctx, page, errs } = await fresh(browser, { width: 1400, height: 1000 }, () => {
    window.__preHasLoading = null;   // 每次导航（含 reload）都由 addInitScript 重置后重新记录
    const snap = () => {
      if (window.__preHasLoading === null) {
        window.__preHasLoading = !!document.querySelector('.game-container.session-loading');
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', snap, { once: true });
    else snap();
  });
  const cells = Array(16).fill(0);
  [0, 3, 6, 9, 12, 15].forEach((i, k) => { cells[i] = 2 << k; });
  await seedAndReload(page, grid(cells, 88));
  const restored = await readState(page);
  // 服务端返回的预渲染 HTML 是确定性的证据
  const html = await (await fetch(BASE + '/game_2048')).text();
  const preScore = /分数：\s*(\d+)/.exec(html)?.[1] ?? null;
  const preBest = /最高分：\s*(\d+)/.exec(html)?.[1] ?? null;
  const preTiles = (html.match(/class="tile [^"]*">\d+/g) || []).length;
  const preHtmlLoading = /class="[^"]*\bsession-loading\b/.test(html);
  await page.goto('/game_2048', { waitUntil: 'domcontentloaded' });
  const first = await readState(page);
  const preHasLoading = await page.evaluate(() => window.__preHasLoading);
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(1100);
  const settled = await readState(page);
  await ctx.close();
  const changed = JSON.stringify(first.tiles) !== JSON.stringify(settled.tiles) || first.score !== settled.score;
  return {
    pass: preHasLoading === true && preHtmlLoading,
    expect: '首帧（DOMContentLoaded）必须处于加载态：容器带 session-loading，而不是看起来像能玩的假新局',
    actual: { preHasLoading, preHtmlLoading,
      prerenderHtml: { score: preScore, best: preBest, numericTiles: preTiles },
      firstPaint: { score: first.score, best: first.best, blocks: nonEmpty(first) },
      afterRestore: { score: settled.score, best: settled.best, blocks: nonEmpty(settled) },
      restoredBefore: { score: restored.score }, changed, errors: errs.slice(0, 3) },
    kind: 'observe',   // P-009 只能缓解（预渲染实例拿不到 sessionStorage），故不进 FAIL 门禁
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
ft('FT-11', 'D-03', '自选/恢复按钮后三行秒数的瞬时一致性（相位对齐）', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const MIN_PHI = 250;
  const secs = () => page.evaluate(() => [...document.querySelectorAll('div.timer')].map(t => {
    const m = /(\d+)\s*秒/.exec(t.textContent); return m ? +m[1] : null;
  }));

  // ① 取一次 φ ≥ MIN_PHI 的加载
  let phi = null;
  for (let i = 0; i < 6; i++) {
    await open(page, '/loveTime', 2200);
    const t = await page.evaluate(() => new Promise(resolve => {
      const el = document.querySelectorAll('div.timer')[0];
      const obs = new MutationObserver(() => { obs.disconnect(); resolve(Date.now()); });
      obs.observe(el, { childList: true, characterData: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(null); }, 5000);
    }));
    if (t !== null && t % 1000 >= MIN_PHI) { phi = t % 1000; break; }
  }
  if (phi === null) {
    await ctx.close();
    return { pass: false, expect: '三行秒数必须同时进入新秒', actual: { error: '6 次加载均未取到 φ ≥ 250ms 的相位' }, kind: 'pass' };
  }

  // ② 等到"下一个整秒边界 + 40ms"，点击，并在下一次 tick 之前轮询
  const nowMs = await page.evaluate(() => Date.now());
  const boundary = Math.floor(nowMs / 1000) * 1000 + 1000;
  await sleep(Math.max(0, boundary + 40 - nowMs));
  await page.evaluate(() => document.querySelectorAll('.love-reset-bar fluent-button')[0].click());

  const deadline = boundary + phi - 40;
  let last = null, bad = null;
  while (Date.now() < deadline) {
    last = await secs();
    if (new Set(last).size > 1) { bad = last; break; }
    await sleep(20);
  }
  await ctx.close();
  return {
    pass: bad === null,
    expect: '整秒边界后点击：三行秒数必须同时进入新秒（未修复时被点行为 k、另两行为 k-1）',
    actual: { phi, mismatch: bad, lastSeen: last, errors: errs.slice(0, 3) },
    kind: 'pass',
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
  // 复刻 P-001 修复【前】的 round 口径（d03_calendar.spec.mjs 已改 floor，此处故意保留旧口径做历史对照）
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
    // 旧判据只检测「文件里有没有这一行」，H-012 修复后该行仍在（只是移进了 dev guard），
    // 字段名因此产生假阳性。改为真正判断它是否落在 if (!IsDevelopment) 块之外。
    httpsRedirectPresent: /app\.UseHttpsRedirection\(\)/.test(read('jtjsym/jtjsym/Program.cs')),
    httpsRedirectOutsideDevGuard: (() => {
      const p = read('jtjsym/jtjsym/Program.cs');
      const i = p.indexOf('app.UseHttpsRedirection()');
      const b = p.indexOf('if (!app.Environment.IsDevelopment())');
      const close = p.indexOf('\n}', b);
      return i >= 0 && (b < 0 || i < b || i > close);
    })(),
  };
  return { pass: true, kind: 'info', expect: '仅登记事实', actual: facts };
});

// ═══════════════ E 组：2026-11-07 修复后复测（本轮新增） ═══════════════
// 定位：17~22 号修复文档的「测试计划」只作线索，**不复用其判据**。
//       针对本轮新引入的 IsValidArchive / isRestoring / await 落盘 / RefreshAll / 标题布局，
//       构造边界输入，专找两类问题：① 修复误伤正常路径；② 修复只收紧未根治。
const capOf = cells => cells.reduce((s, v) => v >= 2 ? s + v * (Math.log2(v) - 1) : s, 0);
const sigOf = s => s.tiles.map(t => parseInt(t, 10) || 0).join(',');
const archOf = st => { try { return st.session ? JSON.parse(st.session) : null; } catch { return null; } };
const firstEffectiveDir = b => ['left', 'down', 'right', 'up']
  .find(d => JSON.stringify(sim(b, d).board) !== JSON.stringify(b)) || null;

ft('FT-18', 'R', '内容闸残余面：可证上界以内的伪高分仍被接受并污染永久最高分', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const cells = Array(16).fill(0);
  cells[0] = 2048; cells[5] = 1024; cells[10] = 512;
  const cap = capOf(cells);
  // 标准 2048 每次合并得分 = 合并结果，恒为 4 的倍数、spawn 不计分 ⇒ 总分必为 4 的倍数。
  // cap-2 既在闸的上界内，又明确不可能由任何真实对局达到（cap-8 反而可能对应两个 spawn 4，不能用作伪分）。
  const fake = cap - 2;
  await open(page, '/game_2048', 900);
  await page.evaluate(b => localStorage.removeItem(b), BEST);
  await seedAndReload(page, grid(cells, fake));
  const restored = await readState(page), st1 = await readStore(page);
  const dir = firstEffectiveDir(boardOf(restored));
  if (dir) await clickDir(page, dir, 500);
  const st2 = await readStore(page);
  await page.evaluate(() => sessionStorage.clear());   // 关掉"会话"，模拟明天再来
  await open(page, '/game_2048', 900);
  const freshBest = bestOf(await readState(page));
  await ctx.close();
  const accepted = scoreOf(restored) === fake;
  const polluted = freshBest >= fake;
  return {
    // 期望：伪分被拒，或至少不得抬升 localStorage 的永久纪录
    pass: !accepted || !polluted,
    expect: '内容闸应拒绝 cap 以内、但非 4 倍数（标准 2048 不可能达到）的伪分；即便接受，也不得写进 localStorage 最高分',
    actual: { cap, fake, fakeIsMultipleOf4: fake % 4 === 0, accepted, restoredScore: restored.score,
      archiveAfterRestore: archOf(st1),
      direction: dir, bestAfterOneMove: st2.best, bestInFreshSession: freshBest, polluted,
      errors: errs.slice(0, 3) },
  };
});

ft('FT-19', 'R', '正向：真实对局产生的存档不被内容闸误杀', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  await open(page, '/game_2048', 1300);
  const steps = [];
  for (let i = 0; i < 12; i++) {
    const s = await readState(page);
    if (s.over) break;
    const d = firstEffectiveDir(boardOf(s));
    if (!d) break;
    await clickDir(page, d, 300);
    steps.push(d);
  }
  const live = await readState(page), liveStore = await readStore(page);
  const arch = archOf(liveStore);
  const { ctx: c2, page: p2, errs: e2 } = await fresh(browser);
  await seedAndReload(p2, arch);
  const back = await readState(p2);
  await c2.close();
  await ctx.close();
  return {
    pass: !!arch && scoreOf(back) === scoreOf(live) && sigOf(back) === sigOf(live),
    expect: '真实对局存档（分数 ≤ 盘面可证上界）必须能原样恢复，分数与 16 格签名逐项一致',
    actual: { steps: steps.length, liveScore: live.score, liveSig: sigOf(live),
      archiveScore: arch?.score ?? null, archiveCap: arch ? capOf(arch.cells) : null,
      restoredScore: back.score, restoredSig: sigOf(back),
      errors: [...errs, ...e2].slice(0, 3) },
  };
});

ft('FT-20', 'R', '恢复失败路径：getItem 抛异常后不能把页面永久卡在「正在恢复对局」', async browser => {
  const { ctx, page, errs } = await fresh(browser, { width: 1400, height: 1000 }, () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function (k) {
      if (k === 'jtjsym.g2048.session') throw new Error('FT-20 injected getItem failure');
      return orig.call(this, k);
    };
  });
  await open(page, '/game_2048', 1800);
  const ui = await page.evaluate(() => ({
    loading: !!document.querySelector('.game-container.session-loading'),
    tip: !!document.querySelector('.session-tip'),
    disabled: [...document.querySelectorAll('.controls fluent-button')].map(b => b.disabled),
    replayDisabled: document.querySelector('.replay-btn')?.disabled ?? null,
    // #blazor-error-ui 是模板常驻元素（默认 display:none），不能按"存在"判出错，必须看可见性
    errorUi: (() => { const e = document.querySelector('#blazor-error-ui');
      return !!e && getComputedStyle(e).display !== 'none'; })(),
  }));
  const before = await readState(page);
  const dir = firstEffectiveDir(boardOf(before));
  if (dir) await clickDir(page, dir, 500);
  const after = await readState(page);
  await ctx.close();
  return {
    pass: !ui.loading && !ui.tip && ui.disabled.every(d => !d) && ui.replayDisabled !== true
      && !ui.errorUi && !!dir && sigOf(after) !== sigOf(before),
    expect: 'finally 必须在恢复的任何失败路径解除 isRestoring：无加载态、按钮全可用、仍可正常走子、circuit 不断',
    actual: { ui, direction: dir, boardChanged: sigOf(after) !== sigOf(before), errors: errs.slice(0, 3) },
  };
});

ft('FT-21', 'R', '恢复窗口内程序化点击方向按钮：不得造成画面与存档分裂', async browser => {
  const { ctx, page, errs } = await fresh(browser, { width: 1400, height: 1000 }, () => {
    window.__ft21 = { clicked: 0 };
    const start = () => {
      const mo = new MutationObserver(() => {
        if (window.__ft21.clicked >= 3) return;
        const b = document.querySelector('.controls fluent-button.dir-btn');
        if (b) { window.__ft21.clicked++; b.click(); }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
  const cells = Array(16).fill(0);
  [0, 3, 6, 9].forEach((i, k) => { cells[i] = 2 << k; });
  await seedAndReload(page, grid(cells, 20));
  const probe = await page.evaluate(() => window.__ft21);
  const s = await readState(page), st = await readStore(page), arch = archOf(st);
  const consistent = !!arch && arch.cells.join(',') === sigOf(s) && String(arch.score) === String(scoreOf(s));
  await ctx.close();
  return {
    pass: consistent,
    expect: 'isRestoring 守卫必须覆盖方向入口：窗口内的点击被忽略，恢复结束后画面与存档逐格一致',
    actual: { clicksInjected: probe?.clicked ?? 0, score: s.score, sig: sigOf(s),
      archiveScore: arch?.score ?? null, archiveSig: arch?.cells?.join(',') ?? null,
      consistent, errors: errs.slice(0, 3) },
  };
});

ft('FT-22', 'R', '键盘路径的「渲染即已落盘」不变式（OnKeyDown 改 async lambda 后）', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  await open(page, '/game_2048', 1500);
  const before = await readState(page);
  await page.evaluate(() => {
    window.__ft22 = [];
    const snap = () => {
      const raw = sessionStorage.getItem('jtjsym.g2048.session');
      const tiles = [...document.querySelectorAll('.game-container .tile')].map(t => t.textContent.trim());
      window.__ft22.push({ raw, tiles: tiles.map(t => parseInt(t, 10) || 0).join(',') });
    };
    const mo = new MutationObserver(snap);
    mo.observe(document.querySelector('.game-container'),
      { childList: true, subtree: true, characterData: true, attributes: true });
  });
  // 先试真实键盘；不生效再退回程序化事件，两种通道都记下来
  await page.keyboard.press('ArrowRight');
  await sleep(450);
  let s1 = await readState(page);
  let channel = 'keyboard.press';
  if (sigOf(s1) === sigOf(before)) {
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    await sleep(450);
    s1 = await readState(page);
    channel = 'dispatchEvent';
  }
  const snaps = await page.evaluate(() => window.__ft22);
  const moved = sigOf(s1) !== sigOf(before);
  const last = snaps[snaps.length - 1] || null;
  const lastArch = last?.raw ? archOf({ session: last.raw }) : null;
  const inSync = !!lastArch && lastArch.cells.join(',') === last.tiles && last.tiles === sigOf(s1);
  await ctx.close();
  return {
    pass: moved && inSync,
    expect: '键盘走子后，DOM 出现该步的同一帧 sessionStorage 必须已是同一盘面（await 落盘不得退回 fire-and-forget）',
    actual: { channel, moved, snapshots: snaps.length, lastDomSig: last?.tiles ?? null,
      lastArchiveSig: lastArch?.cells?.join(',') ?? null, finalDomSig: sigOf(s1), inSync,
      errors: errs.slice(0, 3) },
  };
});

ft('FT-23', 'R', '快速切页 / 连续刷新下 circuit 与 disposed 守卫的稳定性', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const trail = [];
  for (let i = 0; i < 6; i++) {
    await page.goto(i % 2 ? '/game_2048' : '/counter', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => trail.push('goto:' + e.message.slice(0, 60)));
    await sleep(120);
  }
  await page.goto('/game_2048', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(1200);
  const s = await readState(page);
  const ui = await page.evaluate(() => ({
    reconnect: (() => { const e = document.querySelector('#blazor-error-ui');
      return !!e && getComputedStyle(e).display !== 'none'; })(),
    loading: !!document.querySelector('.game-container.session-loading'),
    tiles: document.querySelectorAll('.game-container .tile').length,
  }));
  await ctx.close();
  return {
    pass: !ui.reconnect && !ui.loading && ui.tiles === 16 && errs.length === 0,
    expect: '快速切页不得触发未处理异常 / 重连横幅 / 永久加载态，最终页面仍可渲染 16 格',
    actual: { trail, ui, score: s.score, errors: errs.slice(0, 5) },
    kind: 'observe',
  };
});

ft('FT-24', 'R', '年份下拉当前年完整性与预渲染首帧（P-014 跨年自愈的运行时可验证部分）', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  // FluentUI 渲染的是 <fluent-select>/<fluent-option>，不是原生 <select>/<option>
  const html = await (await fetch(BASE + '/loveTime')).text();
  const preOptions = (html.match(/<fluent-option\b/g) || []).length;
  await open(page, '/loveTime', 1300);
  const sels = await page.evaluate(() => [...document.querySelectorAll('fluent-select')]
    .map(s => [...s.querySelectorAll('fluent-option')].map(o => o.textContent.trim()))
    .filter(a => a.length > 20 && /^\d{4}$/.test(a[0])));
  await ctx.close();
  const year = new Date().getFullYear();
  const want = year - 1950 + 1;
  // 页面只有一组日期选择器：年(77) / 月(12) / 日(31)，故年份下拉恒为 1 个
  const ok = sels.length === 1 && sels.every(a => a.length === want && a[0] === '1950' && a[a.length - 1] === String(year));
  return {
    pass: ok && preOptions >= want,
    expect: `年份下拉含 1950~${year} 共 ${want} 项，且预渲染首帧就带 fluent-option（不是空 select 闪一下）`,
    actual: { year, want, prerenderOptionCount: preOptions,
      runtimeYearSelects: sels.map(a => ({ count: a.length, first: a[0], last: a[a.length - 1] })),
      errors: errs.slice(0, 3),
      note: '跨年自愈需改服务端时钟，Node 侧无法伪造；仅静态复核 EnsureYearsFresh 的触发条件' },
  };
});

ft('FT-25', 'R', 'Tetris 新增 <h1> 后多视口布局：标题高度与 min-height 的 30px 硬编码是否对齐', async browser => {
  const rows = [];
  for (const vp of [{ width: 320, height: 568 }, { width: 375, height: 667 },
                    { width: 768, height: 1024 }, { width: 1400, height: 900 }]) {
    const { ctx, page, errs } = await fresh(browser, vp);
    await open(page, '/tetris', 900);
    const m = await page.evaluate(() => {
      const h1 = document.querySelector('h1.tetris-title');
      const cs = h1 ? getComputedStyle(h1) : null;
      const c = document.querySelector('.tetris-container');
      const cv = document.querySelector('canvas');
      const r = cv?.getBoundingClientRect();
      return {
        h1: !!h1,
        outerH: h1 ? h1.getBoundingClientRect().height + parseFloat(cs.marginBottom || 0) : null,
        lineHeight: cs?.lineHeight ?? null, marginBottom: cs?.marginBottom ?? null,
        minHeight: c ? getComputedStyle(c).minHeight : null,
        scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        scrollH: document.documentElement.scrollHeight, innerH: window.innerHeight,
        canvasBottom: r ? Math.round(r.bottom) : null,
      };
    });
    rows.push({ vp: vp.width, ...m, errors: errs.slice(0, 2) });
    await ctx.close();
  }
  const bad = rows.filter(r => !r.h1 || r.scrollW > r.clientW || Math.abs((r.outerH ?? 0) - 30) > 1);
  return {
    pass: bad.length === 0,
    expect: '四档视口均有标题、无横向溢出，且标题外高恰为 30px（与 CSS 里两处 calc 的减数一致）',
    actual: { rows, badWidths: bad.map(r => r.vp),
      note: '纵向溢出单独登记：H-006 历史项，加标题后是否恶化见 rows.scrollH/innerH' },
  };
});

ft('FT-26', '静态', '修复一致性巡检：文档声称 / 判据口径 / 代码事实三者是否对齐', async () => {
  const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const g = read('jtjsym/jtjsym/Pages/MyPage/Game_2048.razor');
  const src = read('Test/functiontest.mjs');
  const t = read('jtjsym/jtjsym/Pages/MyPage/Tetris.razor');
  const lt = read('jtjsym/jtjsym/Pages/MyPage/LoveTime.razor');
  const css = read('jtjsym/jtjsym/wwwroot/css/site.css');
  const docDir = path.join(ROOT, '1设计文档/2过程设计文件/202611');
  const docs = fs.existsSync(docDir)
    ? fs.readdirSync(docDir).filter(f => f.startsWith('19-修复文档'))
        .map(f => fs.readFileSync(path.join(docDir, f), 'utf8')).join('\n')
    : '';
  const facts = {
    doc19ClaimsFt09Pass: /FT-09 转 PASS/.test(docs),
    // 按用例边界切片，避免用固定长度正则跨段误配
    ft09ActuallyObserve: (() => { const a = src.indexOf("ft('FT-09'"), b = src.indexOf("ft('FT-10'");
      return a >= 0 && b > a && /kind: 'observe'/.test(src.slice(a, b)); })(),
    ft07GateDropsInstantReload: /pass: afterDom\.lost === 0/.test(src),
    ft06ReclassifiedToCloneSemantics: /克隆 sessionStorage/.test(src),
    loadingCssIsVisualOnly: /\.game-container\.session-loading[\s\S]{0,200}?opacity/.test(css)
      && /pointer-events:\s*none/.test(css),
    archiveCapIsUpperBoundNotExact: /score <= scoreCap/.test(g),
    restoreNoBestWrite: !/恢复分支[\s\S]{0,80}UpdateBestScore/.test(g),
    tetrisDisposeFirstLine: /public async ValueTask DisposeAsync\(\)\s*\{\s*Dispose\(\);/.test(t),
    loveTimeRefreshAllOnCallback: /anchorDates\[type\] = selectedDate;\s*RefreshAll\(\);/.test(lt),
    unusedNavigationInjection: /@inject NavigationManager Navigation/.test(g),
    pauseStillMissesDifficultyTimer: /private void PauseGame\(\)[\s\S]{0,220}?gameTimer\?\.Stop\(\);/.test(t)
      && !/PauseGame\(\)[\s\S]{0,220}?difficultyTimer\?\.Stop\(\)/.test(t),
  };
  return { pass: true, kind: 'info', expect: '仅登记事实，供报告区分「代码修复」与「判据/口径改写」', actual: facts };
});

ft('FT-27', 'R', '内容闸拒档后应清除坏档：二次进入不得残留或重复拒绝', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const cells = Array(16).fill(0); cells[0] = -2;
  await seedAndReload(page, grid(cells, -5));
  const s1 = await readState(page), st1 = await readStore(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(1000);
  const s2 = await readState(page), st2 = await readStore(page);
  await ctx.close();
  return {
    pass: st1.session === null && st2.session === null && scoreOf(s1) === 0 && scoreOf(s2) === 0,
    expect: '被拒的坏档应从 sessionStorage 移除，二次进入仍是干净新局，不留残留',
    actual: { firstPass: { score: s1.score, blocks: nonEmpty(s1), session: st1.session },
      secondPass: { score: s2.score, blocks: nonEmpty(s2), session: st2.session },
      errors: errs.slice(0, 3) },
  };
});

ft('FT-28', 'R', '恢复窗口内注入键盘方向事件：按键静默丢弃且画面存档一致', async browser => {
  const { ctx, page, errs } = await fresh(browser, { width: 1400, height: 1000 }, () => {
    window.__ft28 = { sent: 0 };
    const fire = () => {
      for (let i = 0; i < 3; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        window.__ft28.sent++;
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fire, { once: true });
    else fire();
  });
  const cells = Array(16).fill(0);
  [0, 3, 6, 9].forEach((i, k) => { cells[i] = 2 << k; });
  await seedAndReload(page, grid(cells, 20));
  const probe = await page.evaluate(() => window.__ft28);
  const s = await readState(page), st = await readStore(page), arch = archOf(st);
  const consistent = !!arch && arch.cells.join(',') === sigOf(s) && String(arch.score) === String(scoreOf(s));
  await ctx.close();
  return {
    pass: consistent,
    expect: '恢复窗口内的键盘输入不得改写对局；窗口结束前按键会被静默丢弃（可用性现象单列登记）',
    actual: { keysInjected: probe?.sent ?? 0, score: s.score, sig: sigOf(s),
      archiveScore: arch?.score ?? null, consistent,
      note: '键盘监听注册在 OnAfterRenderAsync 的恢复分支之后，故窗口内按键无人接收',
      errors: errs.slice(0, 3) },
    kind: 'observe',
  };
});

ft('FT-29', 'R', '内容闸值域上界：131072 接受 / 262144 拒绝 / 非 2 幂拒绝', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const rows = [];
  for (const [name, v, want] of [['2^17 边界', 131072, true], ['2^18 越界', 262144, false], ['非 2 幂 6', 6, false]]) {
    const cells = Array(16).fill(0); cells[0] = v;
    await seedAndReload(page, grid(cells, 0));
    const s = await readState(page);
    const first = parseInt(s.tiles[0], 10) || 0;
    rows.push({ name, value: v, expectedAccept: want, firstTile: first, accepted: first === v, score: s.score });
  }
  await ctx.close();
  return {
    pass: rows.every(r => r.accepted === r.expectedAccept),
    expect: 'MaxTileValue = 1<<17：等于上界的最大块应可恢复，超过上界与非 2 幂应退化为新局',
    actual: { rows, errors: errs.slice(0, 3) },
  };
});

// ═══════════════ D 组：23~27 号 H 系列修复后的独立探测（2026-11-07 第 2 轮） ═══════════════
// 原则：不复制修复文档 §4 的门禁，只打「修复本身引入的新边界」与「门禁没覆盖的路径」。

ft('FT-30', 'H', 'D-08 边界：页面初始即在后台打开时 register 是否同步当前可见性', async browser => {
  const run = async (hidden) => {
    let frames = 0;
    const { ctx, page, errs } = await fresh(browser, { width: 1400, height: 1000 },
      hidden ? () => { Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }); } : null);
    page.on('websocket', ws => ws.on('framereceived', () => { frames++; }));
    await open(page, '/loveTime', 1800);
    const rows = [];
    for (let i = 0; i < 4; i++) {
      rows.push(await page.evaluate(() => document.querySelector('div.timer')?.textContent.trim() ?? null));
      await sleep(1200);
    }
    const state = await page.evaluate(() => document.visibilityState);
    await ctx.close();
    return { state, rows, changed: new Set(rows.filter(Boolean)).size > 1, wsFrames: frames, errors: errs.slice(0, 3) };
  };
  const hidden = await run(true), visible = await run(false);
  return {
    pass: hidden.changed === false && visible.changed === true,
    expect: '初始即 hidden 的标签应同样暂停秒刷（不推 SignalR 帧）；visible 对照组必须仍在刷新',
    actual: { hidden, visible,
      rootCause: 'lovetimer.js 的 register() 只在 visibilitychange 事件里通知 .NET，注册时不读 document.visibilityState；初始已在后台则无事件可派发，组件 isHidden 恒为 false' },
  };
});

ft('FT-31', 'H', 'D-08 正向：后台→前台应先补刷一次再恢复秒刷（不等下一个 tick）', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  await open(page, '/loveTime', 1600);
  const line = () => page.evaluate(() => document.querySelector('div.timer')?.textContent.trim() ?? null);
  const setVis = state => page.evaluate(s => {
    if (s === null) {
      const d = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
      Object.defineProperty(document, 'visibilityState', d);
    } else Object.defineProperty(document, 'visibilityState', { get: () => s, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  const before = await line();
  await setVis('hidden');
  await sleep(3200);
  const during = await line();
  await setVis(null);
  await sleep(200);                 // 只够 interop 往返，远小于 1s tick —— 若没补刷这里仍是旧值
  const immediate = await line();
  await sleep(1300);
  const after = await line();
  const years = await page.evaluate(() => {
    const opts = [...document.querySelectorAll('fluent-option')].map(o => o.textContent.trim()).filter(t => /^\d{4}$/.test(t));
    return { count: opts.length, first: opts[0] ?? null, last: opts[opts.length - 1] ?? null };
  });
  await ctx.close();
  return {
    pass: during === before && immediate !== during && after !== immediate,
    expect: 'hidden 期间主行冻结；恢复后立刻（<1 tick）补刷到当前时间；随后秒刷继续',
    actual: { before, during, immediate, after, years, errors: errs.slice(0, 3) },
    kind: 'observe',
  };
});

ft('FT-32', 'H', 'H-008 抽离等价性：独立 2048 实现回放多步走子的分数与盘面签名', async browser => {
  const { ctx, page, errs } = await fresh(browser);
  const cells = Array(16).fill(0);
  [2, 4, 8, 16, 2, 4].forEach((v, i) => { cells[i] = v; });
  await seedAndReload(page, grid(cells, 0));
  let s = await readState(page), b = boardOf(s);
  const rows = [];
  for (const dir of ['left', 'down', 'right', 'up', 'left', 'down']) {
    const exp = sim(b, dir);
    if (JSON.stringify(exp.board) === JSON.stringify(b)) { rows.push({ dir, skipped: true }); continue; }
    await clickDir(page, dir, 380);
    const s1 = await readState(page), got = boardOf(s1);
    const diff = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
      if (got[r][c] !== exp.board[r][c]) diff.push({ r, c, expected: exp.board[r][c], actual: got[r][c] });
    const gainActual = scoreOf(s1) - scoreOf(s);
    const spawnOK = diff.length === 1 && exp.board[diff[0].r][diff[0].c] === 0 && [2, 4].includes(diff[0].actual);
    rows.push({ dir, gainExpected: exp.gain, gainActual, spawnOK, diff });
    b = got; s = s1;
  }
  const core = readSrc('jtjsym/jtjsym/Services/Game2048Core.cs');
  await ctx.close();
  const checked = rows.filter(r => !r.skipped);
  return {
    pass: checked.length >= 4 && checked.every(r => r.spawnOK && r.gainActual === r.gainExpected) && errs.length === 0,
    expect: '抽离到 Services/Game2048Core 后，每步的合并结果 = 独立实现 + 恰好 1 个 spawn，且得分增量严格相等',
    actual: { rows, checked: checked.length, errors: errs.slice(0, 3),
      note: 'Core.Merge 的补零用 line.Length（原组件用 GridSize=4）；当前所有调用都传 4 格故等价，若将来传入异长线，SetRow/SetColumn 会拿到异长数组' },
  };
});

ft('FT-33', 'H', 'H-006 横屏四档视口：棋盘/侧栏/操作区完整可见且无横向溢出', async browser => {
  const rows = [];
  for (const vp of [{ width: 844, height: 390 }, { width: 812, height: 375 },
                    { width: 740, height: 360 }, { width: 667, height: 375 }]) {
    const { ctx, page, errs } = await fresh(browser, vp);
    await open(page, '/tetris', 900);
    await page.waitForSelector('.game-canvas', { timeout: 8000 }).catch(() => {});
    const m = await page.evaluate(() => {
      const q = s => document.querySelector(s)?.getBoundingClientRect();
      // 棋盘是 div 网格（.game-canvas），不是 <canvas>；--cell-size 定义在 .tetris-container 上
      const cv = q('.game-canvas'), sp = q('.side-panel'), ct = q('.game-controls');
      const cell = document.querySelector('.grid-cell');
      return { vh: innerHeight, vw: innerWidth,
        canvasBottom: cv ? Math.round(cv.bottom) : null,
        panelBottom: sp ? Math.round(sp.bottom) : null,
        controlsBottom: ct ? Math.round(ct.bottom) : null,
        canvasWidth: cv ? Math.round(cv.width) : null,
        cellSize: cell ? getComputedStyle(cell).width : null,
        boardCells: document.querySelectorAll('.grid-cell').length,
        scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        scrollH: document.documentElement.scrollHeight };
    });
    rows.push({ vp: `${vp.width}x${vp.height}`, ...m, errors: errs.slice(0, 2) });
    await ctx.close();
  }
  const hardBad = rows.filter(r => r.canvasBottom === null || r.panelBottom === null || r.canvasBottom > r.vh || r.panelBottom > r.vh);
  const softBad = rows.filter(r => r.controlsBottom !== null && r.controlsBottom > r.vh + 10);
  const widthBad = rows.filter(r => r.scrollW > r.clientW);
  return {
    pass: hardBad.length === 0 && softBad.length === 0 && widthBad.length === 0,
    expect: '四档横屏：棋盘与侧栏底部不超视口、操作区溢出 ≤10px、无横向溢出',
    actual: { rows, hardBad: hardBad.map(r => r.vp), softBad: softBad.map(r => r.vp),
      widthBad: widthBad.map(r => r.vp),
      note: '《23》v2.0 自述 844×390 下格子降到 ~12.4px、横向留白，属已接受的取舍；这里记录实测值' },
    kind: 'observe',
  };
});

ft('FT-34', 'H', 'H-004/005/010 样式域清理：选择器清零、编码、全局色规则与文本色抽查', async browser => {
  const css = readSrc('jtjsym/jtjsym/wwwroot/css/site.css');
  const counter = readSrc('jtjsym/jtjsym/Pages/MyPage/Counter.razor');
  const specs = ['nav_fish', 'code_nf', 'smoke', 'd15_home_fluent']
    .map(n => readSrc(`tools/e2e/tests/${n}.spec.mjs`)).join('\n');
  const editor = readSrc('.editorconfig');
  const facts = {
    btnPrimaryInCounter: (counter.match(/\.btn-primary/g) || []).length,
    btnPrimaryInSiteCss: (css.match(/\.btn-primary/g) || []).length,
    btnPrimaryInSpecs: (specs.match(/\.btn-primary/g) || []).length,
    muyuBtnInCounter: (counter.match(/\.muyu-btn/g) || []).length,
    muyuBtnClassInMarkup: /class="muyu-btn"/.test(counter),
    muyuBtnActivePresent: /\.muyu-btn:active/.test(counter),
    globalDivColorRule: /div\s*\{[^}]*color\s*:/.test(css),
    garbledLines: css.split('\n').filter(l => /[\u00c0-\u00ff]{3,}/.test(l)).length,
    editorconfigInlineHash: editor.split('\n').filter(l => /^\s*[\w.*]+\s*=\s*[^#]*#/.test(l)).length,
  };
  const colors = [];
  for (const route of ['/', '/counter', '/loveTime', '/game_2048', '/tetris', '/coding_place']) {
    const { ctx, page } = await fresh(browser);
    await open(page, route, 700);
    colors.push(await page.evaluate(() => {
      const body = getComputedStyle(document.body).color;
      const nodes = [...document.querySelectorAll('body *')]
        .filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()));
      const uniq = [...new Set(nodes.slice(0, 120).map(e => getComputedStyle(e).color))];
      return { route: location.pathname, bodyColor: body, textNodes: nodes.length, distinctColors: uniq.length,
        sample: uniq.slice(0, 6) };
    }));
    await ctx.close();
  }
  const clean = facts.btnPrimaryInCounter === 0 && facts.btnPrimaryInSiteCss === 0
    && facts.btnPrimaryInSpecs === 0 && facts.muyuBtnInCounter >= 2 && facts.muyuBtnClassInMarkup && facts.muyuBtnActivePresent
    && !facts.globalDivColorRule && facts.garbledLines === 0 && facts.editorconfigInlineHash === 0;
  return {
    pass: clean,
    expect: '.btn-primary 全仓清零且 :active 改名到位；site.css 无乱码注释、无全局 div{color}；.editorconfig 无非法行内 # 注释',
    actual: { facts, colors, note: '无改前基线，颜色只做分布抽查（6 路由），不做逐节点 diff' },
  };
});

ft('FT-35', 'H', 'H-009 参考答案折叠区：默认收起、答案特征、预渲染 HTML 是否已含答案', async browser => {
  const html = await (await fetch(BASE + '/coding_place')).text();
  const { ctx, page, errs } = await fresh(browser);
  await open(page, '/coding_place', 800);
  const dom = await page.evaluate(() => {
    const d = document.querySelector('details.code-answer');
    const pre = d?.querySelector('.code-answer-pre');
    return { exists: !!d, openDefault: d?.open ?? null,
      summary: d?.querySelector('summary')?.textContent.trim() ?? null,
      answerLength: pre?.textContent.length ?? 0,
      hasInclude: /#include/.test(pre?.textContent || ''), hasStructTask: /struct\s+Task/.test(pre?.textContent || ''),
      htmlInputs: document.querySelectorAll('input,textarea').length };
  });
  const code = readSrc('jtjsym/jtjsym/Pages/MyPage/CodingPlace.razor');
  const readonlyFields = (code.match(/private readonly string/g) || []).length;
  await ctx.close();
  return {
    pass: dom.exists && dom.openDefault === false && dom.hasInclude && readonlyFields >= 2,
    expect: '折叠区默认收起、summary 存在、答案含 #include；题面与答案两个 C# 字段声明为 readonly',
    actual: { dom, readonlyFields, answerInPrerenderedHtml: /#include/.test(html),
      note: '答案文本在预渲染 HTML 与 DOM 中已存在，折叠只是视觉收起；查看源代码/F12 可绕过（技术要点，不判缺陷）',
      errors: errs.slice(0, 3) },
    kind: 'info',
  };
});

ft('FT-36', 'H', 'H-001 暂停期难度守卫 + H-012 HTTPS 重定向归位（静态守卫）', async () => {
  const t = readSrc('jtjsym/jtjsym/Pages/MyPage/Tetris.razor');
  const p = readSrc('jtjsym/jtjsym/Program.cs');
  const slice = (s, from, len) => { const i = s.indexOf(from); return i < 0 ? '' : s.slice(i, i + len); };
  const devBlock = slice(p, 'if (!app.Environment.IsDevelopment())', 700);
  const facts = {
    pauseStopsDifficulty: /difficultyTimer\?\.Stop\(\)/.test(slice(t, 'void PauseGame', 700)),
    resumeStartsDifficulty: /difficultyTimer\?\.Start\(\)/.test(slice(t, 'void ResumeGame', 700)),
    increaseGuardHasPaused: /isPaused/.test(slice(t, 'private void IncreaseDifficulty', 400)),
    httpsInsideDevGuard: /UseHttpsRedirection\(\)/.test(devBlock),
    httpsOutsideDevGuard: (() => {
      const i = p.indexOf('UseHttpsRedirection()'); const b = p.indexOf('if (!app.Environment.IsDevelopment())');
      return i >= 0 && (b < 0 || i < b);
    })(),
    tris26TimeoutRaised: /test\.setTimeout\(\s*240_000/.test(readSrc('tools/e2e/tests/tris.spec.mjs')),
  };
  return {
    pass: facts.pauseStopsDifficulty && facts.resumeStartsDifficulty && facts.increaseGuardHasPaused
      && facts.httpsInsideDevGuard && !facts.httpsOutsideDevGuard && facts.tris26TimeoutRaised,
    expect: 'PauseGame 停难度计时器、ResumeGame 重启、IncreaseDifficulty 有 isPaused 守卫；UseHttpsRedirection 仅非开发环境启用；TRIS-26 解锁时同步抬超时',
    actual: { facts, runtimeNote: '14077 启动日志未再出现 "Failed to determine the https port"，H-012 的直接可观测证据' },
  };
});

ft('FT-37', 'H', 'H-002/007/011 工程治理巡检：备案链接、CI YAML 覆盖、skip/fixme 与 test:all', async () => {
  const idx = readSrc('jtjsym/jtjsym/Pages/Index.razor');
  const yml = readSrc('.github/workflows/tests.yml');
  const pkg = JSON.parse(readSrc('tools/e2e/package.json'));
  const specDir = path.join(ROOT, 'tools/e2e/tests');
  const specs = fs.readdirSync(specDir).filter(f => f.endsWith('.spec.mjs'))
    .map(f => ({ file: f, src: fs.readFileSync(path.join(specDir, f), 'utf8') }));
  const all = specs.map(s => s.src).join('\n');
  const prGrep = /run:\s*npx playwright test --project=chromium --grep "([^"]+)"/.exec(yml)?.[1] ?? '';
  const facts = {
    beianMiit: /beian\.miit\.gov\.cn/.test(idx),
    beianOld: /beian\.mps\.gov\.cn|www\.beian\.gov\.cn/.test(idx),
    ciJobs: (yml.match(/^  \w+:\s*$/gm) || []).length,
    ciHasUnitJob: /^  unit:/m.test(yml), ciHasE2eJob: /^  e2e:/m.test(yml),
    ciNoBaseUrlEnv: !/env:\s*\n\s*BASE_URL/.test(yml),
    ciHasDevelopmentEnv: /--environment Development/.test(readSrc('tools/e2e/playwright.config.mjs')),
    prGrep, d08CoveredByPrGreen: /D08/.test(prGrep),
    testAllIncludesUnit: /npm run test:unit/.test(pkg.scripts['test:all'] || '')
      && /dotnet test/.test(pkg.scripts['test:unit'] || ''),
    testD08Script: pkg.scripts['test:d08'] || null,
    fixmeCount: (all.match(/test\.fixme\s*\(/g) || []).length,
    conditionalSkipCount: (all.match(/test\.skip\s*\(/g) || []).length,
    specFiles: specs.length,
    unitTestProjectExists: fs.existsSync(path.join(ROOT, 'jtjsym/jtjsym.Tests/Game2048CoreTests.cs')),
  };
  return {
    pass: facts.beianMiit && !facts.beianOld && facts.ciHasUnitJob && facts.ciHasE2eJob
      && facts.testAllIncludesUnit && facts.unitTestProjectExists,
    expect: '备案链接指向工信部；CI 有 unit+e2e 两 job；test:all 串上 dotnet test；单测项目已入仓',
    actual: { facts,
      note: facts.d08CoveredByPrGreen ? '' : 'CI PR/push 的 --grep 不含 D08-，新增的 3 条 H-003 门禁用例在 PR 上永远不跑，只有夜间/手动全量才覆盖' },
    kind: 'info',
  };
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
