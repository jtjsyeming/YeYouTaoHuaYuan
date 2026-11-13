// H-013：网站扫雷（MS-01~MS-13）。
// 存储键全部带 jtjsym. 命名空间（与 jtjsym.g2048.* / jtjsym.tetris.* 同一约定，《34》§2.3）：
//   sessionStorage['jtjsym.ms.session']            对局进度
//   localStorage['jtjsym.ms.fastest.beginner']     初级最快时间（**秒**，越小越好）
//   localStorage['jtjsym.ms.fastest.intermediate'] 中级最快时间
// ⚠ 键名是 fastest 而不是 best（C-59 改名）：扫雷的指标方向与 2048/Tetris 相反，
//   别用 helpers.readBest（它的正则锚的是「最高分」，对扫雷恒返回 -1）。
//
// 三条判据纪律（沿用 C-53/54 的教训）：
//   ① 点击后一律 `expect.poll` 读 DOM —— Blazor Server 的 click 在服务端处理，`click()` resolve ≠ DOM 已更新。
//   ② 先 poll DOM，再 poll 存储；不要拿存储的 poll 当延时（值早在盘上时会立刻返回）。
//   ③ 预渲染占位只能用**原始 HTML** 断言；`open()` settle 1500ms 后占位早已被替换。
import { expect, test } from '@playwright/test';
import {
  check,
  checkEq,
  open,
  pickSelect,
  sleep,
  trackErrors,
  viewportMetrics,
} from './helpers.mjs';

const SK = 'jtjsym.ms.session';
const BK_BEGINNER = 'jtjsym.ms.fastest.beginner';
const BK_INTERMEDIATE = 'jtjsym.ms.fastest.intermediate';

const sessionRaw = page => page.evaluate(k => sessionStorage.getItem(k), SK);
const storedBest = (page, key = BK_BEGINNER) => page.evaluate(k => localStorage.getItem(k), key);

/** 读整盘 DOM。cells 里保留原始 className，便于按 ms-revealed / ms-flag / ms-mine / ms-hit 分类。 */
const readMs = page =>
  page.evaluate(() => {
    const txt = sel => (document.querySelector(sel)?.textContent || '').trim();
    const num = s => {
      const m = /(\d+)/.exec(s || '');
      return m ? +m[1] : -1;
    };
    const cells = [...document.querySelectorAll('.ms-cell')].map(c => ({
      cls: c.className,
      text: c.textContent.trim(),
    }));
    const board = document.querySelector('.ms-board');
    const first = document.querySelector('.ms-cell');
    return {
      count: cells.length,
      cells,
      revealed: cells.filter(c => c.cls.includes('ms-revealed')).length,
      flagged: cells.filter(c => c.cls.includes('ms-flag')).length,
      bombs: cells.filter(c => c.text === '💣').length,
      minesLeft: num(txt('.ms-mines-left')),
      elapsed: num(txt('.ms-elapsed')),
      over: !!document.querySelector('.ms-overlay'),
      overlayTitle: txt('.ms-overlay-title'),
      resumeTip: !!document.querySelector('.ms-resume-tip'),
      bests: [...document.querySelectorAll('.best-score')].map(e => e.textContent.trim()),
      boardWidth: board ? Math.round(board.getBoundingClientRect().width) : 0,
      cellWidth: first ? first.getBoundingClientRect().width : 0,
    };
  });

/**
 * 读「最快时间」那一行。
 * D-29 之前页面上是**两段并排**（初级恒在前、中级恒在后，都没有难度标签），必须点名 data-diff；
 * 单行化之后默认取那唯一一行即可 —— 不传 diff 反而更稳：写死 'beginner' 在中级视图下会命中不到元素、
 * **静默返回空串**，后面 `toContain('最快时间')` 就变成一句莫名其妙的失败。
 * 需要点名某档时（如断言"中级自己没有纪录"）传 'intermediate' 仍然精确。
 * ⚠ 不要"统一取数口径"改用 helpers.readBest：它的正则锚「最高分」，对扫雷恒返回 -1（《现状》§3.2 已写明）。
 */
const bestText = (page, diff) =>
  page.evaluate(d => {
    const sel = d ? `.best-score[data-diff="${d}"]` : '.best-score';
    return (document.querySelector(sel)?.textContent || '').trim();
  }, diff);

/** 直写会话档 + reload。⚠ 不要用 addInitScript：它每次导航都会重跑，会冲掉"恢复后新写的档"。 */
async function seedSession(page, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [SK, text]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});
  await sleep(900);
}

const clearSession = async page => {
  await page.evaluate(k => sessionStorage.removeItem(k), SK);
};

/** 清掉两档的最快时间（MS-13 要一个"盘上还没有纪录"的起点，MS-09 要"中级档确实是空的"）。 */
const clearFastest = async page => {
  await page.evaluate(k => localStorage.removeItem(k), BK_BEGINNER);
  await page.evaluate(k => localStorage.removeItem(k), BK_INTERMEDIATE);
};

/**
 * 造一份合法会话档。
 * @param mineIdx  雷位（一维下标）
 * @param reveal   'all' = 翻开除 leave 外的全部安全格；数组 = 只翻开这些格
 * @param leave    留成未翻的安全格（-1 = 不留）
 *
 * 数字必须与雷位自洽 —— 页面的内容闸会逐格校验相邻雷数，写错一格整档就会被丢弃。
 */
function msSnapshot({ rows = 9, cols = 9, mineIdx, reveal = 'all', leave = -1, elapsed = 3 } = {}) {
  const n = rows * cols;
  const isMine = new Array(n).fill(false);
  mineIdx.forEach(i => (isMine[i] = true));

  const adj = i => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    let k = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        if (isMine[rr * cols + cc]) k++;
      }
    }
    return k;
  };

  const cells = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (isMine[i]) {
      cells[i] = -2;
      continue;
    }
    const show = reveal === 'all' ? i !== leave : reveal.includes(i);
    if (show) cells[i] = adj(i);
  }

  return {
    v: 1,
    rows,
    cols,
    mineCount: mineIdx.length,
    difficulty: rows === 9 ? 'beginner' : 'intermediate',
    elapsedSec: elapsed,
    minesPlaced: true,
    cells,
    flags: new Array(n).fill(false),
  };
}

/** 第 0 行整排 10 雷：下标 0 是雷（MS-05 踩它），(8,8)=80 永远是安全格（MS-06 留它）。 */
const ROW0_MINES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * D-26 的确定性雷位（《35》§4.4）：安全格 71 个，洪泛从 50 号连通出去**不会**覆盖 8 号与 11 号。
 * 邻雷数：30→2、50→0、8→1、11→4（11 号邻域有 4 颗雷，是数字边界格）。
 */
const SEED_D26 = [0, 1, 2, 3, 4, 5, 6, 7, 20, 29];

const idxOf = (r, c, cols = 9) => r * cols + c;

test.describe('MS 扫雷', () => {
  test('MS-01 首屏：81 格、难度两档、单行最快时间（跟随难度）、剩余雷 10；预渲染占位为「—」', async ({ page, request }) => {
    // 占位只能读原始 HTML：open() 之后 hydrate 早已把它换掉了
    const html = await (await request.get('/minesweeper')).text();
    check(
      'MS-01-占位',
      /&#x2014;|—/.test(html),
      `预渲染 HTML 含破折号占位=${/&#x2014;|—/.test(html)}（服务端没有 localStorage ⇒ 天然是占位）`,
    );

    await open(page, '/minesweeper');
    const st = await readMs(page);

    const optionCount = await page.locator('fluent-option').count();
    check('MS-01', st.count === 81 && optionCount === 2 && st.minesLeft === 10, `格子=${st.count} 难度选项=${optionCount} 剩余雷=${st.minesLeft}`);
    check(
      'MS-01-最快时间',
      st.bests.length === 1 && st.bests[0].startsWith('最快时间：'),
      `最快时间行数=${st.bests.length} 内容=${JSON.stringify(st.bests)}（D-29 后只显示当前难度一段）`,
    );
    check('MS-01-未开局', st.revealed === 0 && !st.over && st.elapsed === 0, `已翻=${st.revealed} 遮罩=${st.over} 用时=${st.elapsed}`);
  });

  test('MS-02 首点安全：角落与中心各一次，首格与 8 邻域无雷且必然洪泛', async ({ page }) => {
    for (const [r, c] of [
      [0, 0],
      [4, 4],
    ]) {
      await open(page, '/minesweeper');
      await clearSession(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(1200);

      const idx = idxOf(r, c);
      await page.locator('.ms-cell').nth(idx).click();
      await expect.poll(() => readMs(page).then(s => s.cells[idx].cls.includes('ms-revealed'))).toBe(true);

      const st = await readMs(page);
      check(
        `MS-02-${r},${c}`,
        !st.cells[idx].text.includes('💣') && st.revealed > 1,
        `首点(${r},${c}) 文本="${st.cells[idx].text}" 翻开=${st.revealed}（>1 说明触发了洪泛）`,
      );

      // MS-02b：直接用存档的雷位图核对"首格 + 8 邻域无雷"（比看 DOM 更硬）
      const raw = await sessionRaw(page);
      const snap = JSON.parse(raw);
      const bad = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= 9 || cc < 0 || cc >= 9) continue;
          if (snap.cells[idxOf(rr, cc)] === -2) bad.push(`(${rr},${cc})`);
        }
      }
      check('MS-02b', snap.minesPlaced === true && bad.length === 0, `minesPlaced=${snap.minesPlaced} 禁区内的雷=${JSON.stringify(bad)}`);
    }
  });

  test('MS-03 洪泛边界：展开区内部全 0、边界全是数字格', async ({ page }) => {
    await open(page, '/minesweeper');
    await clearSession(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);

    await page.locator('.ms-cell').nth(40).click();
    await expect.poll(() => readMs(page).then(s => s.revealed)).toBeGreaterThan(1);

    const snap = JSON.parse(await sessionRaw(page));
    const revealed = i => snap.cells[i] >= 0;
    const holes = [];
    let boundary = 0;
    for (let i = 0; i < 81; i++) {
      if (!revealed(i)) continue;
      const r = Math.floor(i / 9);
      const c = i % 9;
      let hiddenNeighbour = false;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= 9 || cc < 0 || cc >= 9) continue;
          const j = rr * 9 + cc;
          if (!revealed(j)) hiddenNeighbour = true;
          else if (snap.cells[i] === 0) {
            /* 0 格的邻格必须已翻 —— 下面统一判 */
          }
        }
      }
      if (snap.cells[i] === 0) {
        // 0 格的所有邻格都必须已翻
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || rr >= 9 || cc < 0 || cc >= 9) continue;
            if (!revealed(rr * 9 + cc)) holes.push(`(${r},${c})→(${rr},${cc})`);
          }
        }
      } else if (hiddenNeighbour) {
        boundary++; // 数字格挨着未翻格 = 展开区的边界，正常
      }
    }
    check('MS-03', holes.length === 0 && boundary > 0, `零格未闭合=${holes.slice(0, 3).join(',') || '无'}；数字边界格=${boundary}`);
  });

  test('MS-04 插旗：右键翻转、剩余雷 10↔9、插旗格左键翻不开', async ({ page }) => {
    await open(page, '/minesweeper');
    await clearSession(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);

    await page.locator('.ms-cell').nth(40).click();
    await expect.poll(() => readMs(page).then(s => s.revealed)).toBeGreaterThan(1);

    // 找一格未翻的
    const st0 = await readMs(page);
    const target = st0.cells.findIndex(c => !c.cls.includes('ms-revealed') && !c.cls.includes('ms-flag'));
    check('MS-04-前置', target >= 0, `未翻格下标=${target}`);

    await page.locator('.ms-cell').nth(target).click({ button: 'right' });
    await expect.poll(() => readMs(page).then(s => s.flagged)).toBe(1);
    let st = await readMs(page);
    checkEq('MS-04-插旗', { flags: st.flagged, left: st.minesLeft }, { flags: 1, left: 9 });

    await page.locator('.ms-cell').nth(target).click({ button: 'right' });
    await expect.poll(() => readMs(page).then(s => s.flagged)).toBe(0);
    st = await readMs(page);
    checkEq('MS-04-取消', { flags: st.flagged, left: st.minesLeft }, { flags: 0, left: 10 });

    // 再插一次旗，然后左键：必须翻不开
    await page.locator('.ms-cell').nth(target).click({ button: 'right' });
    await expect.poll(() => readMs(page).then(s => s.flagged)).toBe(1);
    const before = (await readMs(page)).revealed;
    await page.locator('.ms-cell').nth(target).click();
    await sleep(600);
    st = await readMs(page);
    check('MS-04-旗挡住左键', st.flagged === 1 && !st.cells[target].cls.includes('ms-revealed') && st.revealed === before,
      `旗=${st.flagged} 该格已翻=${st.cells[target].cls.includes('ms-revealed')} 已翻总数=${before}→${st.revealed}`);
  });

  test('MS-05 败局：踩雷遮罩、全雷现身、计时停、会话档被删', async ({ page }) => {
    await open(page, '/minesweeper');
    await seedSession(page, msSnapshot({ mineIdx: ROW0_MINES, reveal: [40], elapsed: 7 }));

    const restored = await readMs(page);
    check('MS-05-前置', restored.revealed === 1 && restored.resumeTip, `恢复后已翻=${restored.revealed} 恢复提示=${restored.resumeTip}`);

    await page.locator('.ms-cell').nth(0).click();
    await expect.poll(() => readMs(page).then(s => s.over)).toBe(true);

    const st = await readMs(page);
    check('MS-05', st.overlayTitle.includes('踩到雷了') && st.bombs === 10, `遮罩="${st.overlayTitle}" 现身雷数=${st.bombs}`);

    // 计时必须停：2.2 秒后再读，秒数不许变
    await sleep(2200);
    check('MS-05-停表', (await readMs(page)).elapsed === st.elapsed, `败局用时 ${st.elapsed}s → 2.2s 后 ${(await readMs(page)).elapsed}s`);

    // 结束态没有可恢复的语义 → 清档（不是"不写"）
    await expect.poll(() => sessionRaw(page), { timeout: 5000 }).toBeNull();
  });

  test('MS-06 胜局 + 纪录：遮罩、最快时间落盘（秒，越小越好）', async ({ page }) => {
    await open(page, '/minesweeper');
    // 全部安全格已翻，只留 (8,8)=80 未翻 ⇒ 点开即胜
    await seedSession(page, msSnapshot({ mineIdx: ROW0_MINES, reveal: 'all', leave: 80, elapsed: 3 }));

    await page.locator('.ms-cell').nth(80).click();
    await expect.poll(() => readMs(page).then(s => s.over)).toBe(true);

    const st = await readMs(page);
    check('MS-06', st.overlayTitle.includes('扫雷成功'), `遮罩="${st.overlayTitle}"`);

    await expect.poll(() => bestText(page), { timeout: 6000 }).toContain('最快时间：3 秒');
    await expect.poll(() => storedBest(page), { timeout: 6000 }).toBe('3');
    checkEq('MS-06-清档', await sessionRaw(page), null);
  });

  test('MS-07 坏值容错：localStorage 是 "abc" 时显示「—」，可正常开局、无异常', async ({ page }) => {
    const errs = trackErrors(page);
    await open(page, '/minesweeper');
    await page.evaluate(k => localStorage.setItem(k, 'abc'), BK_BEGINNER);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1400);

    const st = await readMs(page);
    check('MS-07', (await bestText(page)) === '最快时间：—', `最快时间文案="${await bestText(page)}"`);

    await page.locator('.ms-cell').nth(40).click();
    await expect.poll(() => readMs(page).then(s => s.revealed)).toBeGreaterThan(1);
    check('MS-07-可玩', (await readMs(page)).revealed > 1 && errs.length === 0, `翻开=${(await readMs(page)).revealed} 异常=${errs.length} ${errs.slice(0, 2).join(' | ')}`);
  });

  test('MS-08 会话保持：切页回来盘面/旗/剩余雷一致、提示恢复、计时续走（含 D-26 洪泛闸）', async ({ page }) => {
    await open(page, '/minesweeper');
    await clearSession(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);

    await page.locator('.ms-cell').nth(40).click();
    await sleep(1500); // 让计时走几秒
    const before = await readMs(page);
    check('MS-08-前置', before.revealed > 1 && before.elapsed >= 1, `离开前 已翻=${before.revealed} 用时=${before.elapsed}s`);

    await page.locator('nav a.fluent-nav-link', { hasText: 'jtjsym' }).first().click();
    await sleep(1200);
    await page.locator('nav a.fluent-nav-link', { hasText: '扫雷' }).first().click();
    await sleep(900);

    const after = await readMs(page);
    checkEq(
      'MS-08-盘面',
      { revealed: after.revealed, left: after.minesLeft },
      { revealed: before.revealed, left: before.minesLeft },
    );
    // 秒数容差 ±1：快照只在翻开/插旗与 DisposeAsync 落盘，而计时是 1 秒一拍 ——
    // 读 before 之后到离开之间可能又跳了一拍（那不是"暂停态在走表"，是存档比读数新 1 秒）。
    check('MS-08-暂停', after.resumeTip && Math.abs(after.elapsed - before.elapsed) <= 1,
      `恢复提示=${after.resumeTip} 用时=${before.elapsed}s→${after.elapsed}s（暂停态不该继续走表，容差 ±1s）`);

    // 续走段改成**确定性 seed**（《35》§4.1）：前半段的真实对局布雷是随机的，"洪泛是否连通全盘"
    // 取决于运气 —— D-26 期间这条就是这么变成 flaky 的（实测 5 跑 1 红）。雷位固定后，
    // 30 号是邻雷 2 的数字格，恢复局点它**只该翻自己**（D-26 回归闸），用时续走仍按原来的量看。
    await seedSession(page, msSnapshot({ mineIdx: SEED_D26, reveal: [40], elapsed: 5 }));
    const rs = await readMs(page);
    check('MS-08-恢复', rs.revealed === 1 && rs.elapsed === 5 && rs.resumeTip,
      `已翻=${rs.revealed} 用时=${rs.elapsed} 提示=${rs.resumeTip}`);

    await page.locator('.ms-cell').nth(30).click();
    await expect.poll(() => readMs(page).then(s => s.revealed), { timeout: 6000 }).toBe(2);
    const rs2 = await readMs(page);
    checkEq('MS-08-D26闸', { revealed: rs2.revealed, over: rs2.over }, { revealed: 2, over: false });
    await expect.poll(() => readMs(page).then(s => s.elapsed), { timeout: 6000 }).toBeGreaterThan(5);
    check('MS-08-续走', (await readMs(page)).elapsed > 5, `续走后用时=${(await readMs(page)).elapsed}s（应 > 5）`);
  });

  test('MS-09 重开与切档：重开归零、最快时间保留；切中级 256 格 / 40 雷 / 清档', async ({ page }) => {
    await open(page, '/minesweeper');
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [BK_BEGINNER, '9']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);
    await clearSession(page);

    await page.locator('.ms-cell').nth(40).click();
    await expect.poll(() => readMs(page).then(s => s.revealed)).toBeGreaterThan(1);

    await page.locator('.ms-restart').click();
    await expect.poll(() => readMs(page).then(s => s.revealed), { timeout: 5000 }).toBe(0);
    const st = await readMs(page);
    checkEq('MS-09-重开', { elapsed: st.elapsed, left: st.minesLeft }, { elapsed: 0, left: 10 });
    check('MS-09-保留纪录', (await bestText(page)) === '最快时间：9 秒', `最快时间="${await bestText(page)}"`);
    await expect.poll(() => sessionRaw(page), { timeout: 5000 }).toBeNull();

    // 切中级：16×16 / 40 雷
    await pickSelect(page, 0, '中级 16×16');
    await expect.poll(() => readMs(page).then(s => s.count), { timeout: 6000 }).toBe(256);
    const mid = await readMs(page);
    checkEq('MS-09-切档', { count: mid.count, left: mid.minesLeft, revealed: mid.revealed }, { count: 256, left: 40, revealed: 0 });
    await expect.poll(() => sessionRaw(page), { timeout: 5000 }).toBeNull();

    // ── D-29：单行跟随难度 ──
    // ① 同一行标的现在是中级（不是并排两段、也不是恒 beginner）
    await expect.poll(() => page.getAttribute('.best-score', 'data-diff'), { timeout: 6000 }).toBe('intermediate');
    // ② 中级档自己没有纪录时显示「—」，**不能**把初级的 9 秒顶上来
    await expect.poll(() => bestText(page, 'intermediate'), { timeout: 6000 }).toBe('最快时间：—');
    // ③ 存储层：切档不许误清另一档。PersistBestAsync 用**改过之后的** difficultyKey 选键，
    //    一旦切档那两步顺序被调换，初级纪录就可能被写成中级值 —— 显示层断言看不见这种坏。
    await expect.poll(() => storedBest(page), { timeout: 6000 }).toBe('9');

    const midDiff = await page.getAttribute('.best-score', 'data-diff');
    const midText = await bestText(page, 'intermediate');
    const beginnerStored = await storedBest(page);
    check('MS-09-单行跟随', midDiff === 'intermediate', `切中级后 data-diff="${midDiff}"（应随难度变化）`);
    check('MS-09-中级无纪录', midText === '最快时间：—', `中级最快时间="${midText}"（不是把初级纪录顶上来）`);
    check('MS-09-初级未被误清', beginnerStored === '9', `初级存储=${beginnerStored}（切档不许误清另一档）`);

    // ④ 用户真实路径：再切回初级，纪录必须还在。这条同时钉住"单行跟随"与"两档独立"。
    await pickSelect(page, 0, '初级 9×9');
    await expect.poll(() => readMs(page).then(s => s.count), { timeout: 6000 }).toBe(81);
    await expect.poll(() => bestText(page), { timeout: 6000 }).toBe('最快时间：9 秒');
    check('MS-09-切回初级', (await bestText(page)) === '最快时间：9 秒', `切回初级后最快时间="${await bestText(page)}"`);
  });

  test('MS-10 窄屏：375/320 无文档级横向溢出，初级格 ≥ 24px', async ({ browser }) => {
    for (const vp of [
      { width: 375, height: 812 },
      { width: 320, height: 568 },
    ]) {
      const ctx = await browser.newContext({ viewport: vp, isMobile: true, hasTouch: true });
      const p = await ctx.newPage();
      await open(p, '/minesweeper');
      const m = await viewportMetrics(p);
      const st = await readMs(p);
      check(
        `MS-10-${vp.width}`,
        m.scrollW <= m.clientW + 1 && st.cellWidth >= 24,
        `文档 ${m.scrollW}/${m.clientW}（无溢出=${m.scrollW <= m.clientW + 1}）初级格=${st.cellWidth.toFixed(1)}px 棋盘=${st.boardWidth}px`,
      );
      await ctx.close();
    }
  });

  test('MS-11 全流程无 console 异常（恢复 / 切档 / 胜负 / 重开）', async ({ page }) => {
    const errs = trackErrors(page);

    // 恢复路径
    await open(page, '/minesweeper');
    await seedSession(page, msSnapshot({ mineIdx: ROW0_MINES, reveal: [40], elapsed: 4 }));

    // 切档
    await pickSelect(page, 0, '中级 16×16');
    await expect.poll(() => readMs(page).then(s => s.count), { timeout: 6000 }).toBe(256);

    // 中级上随手翻一格
    await page.locator('.ms-cell').nth(0).click();
    await sleep(800);

    // 重开 + 切回初级
    await page.locator('.ms-restart').click();
    await sleep(600);
    await pickSelect(page, 0, '初级 9×9');
    await expect.poll(() => readMs(page).then(s => s.count), { timeout: 6000 }).toBe(81);

    // 败局路径（预置一份只剩雷可点的档）
    await seedSession(page, msSnapshot({ mineIdx: ROW0_MINES, reveal: [40], elapsed: 2 }));
    await page.locator('.ms-cell').nth(0).click();
    await expect.poll(() => readMs(page).then(s => s.over)).toBe(true);

    check('MS-11', errs.length === 0, errs.length ? errs.slice(0, 4).join(' | ') : '恢复/切档/翻开/败局四条路径均无 console error');
  });

  test('MS-12 恢复局洪泛边界：点零格停在 69 格，还剩 {8,11}，逐个点开才胜', async ({ page }) => {
    await open(page, '/minesweeper');
    await seedSession(page, msSnapshot({ mineIdx: SEED_D26, reveal: [40], elapsed: 5 }));

    const restored = await readMs(page);
    check('MS-12-前置', restored.revealed === 1 && restored.resumeTip, `恢复后已翻=${restored.revealed} 恢复提示=${restored.resumeTip}`);

    // 50 号是零格（邻雷 0）⇒ 触发洪泛；修复后必须停在 69 格，而不是一口气展开到 71 判胜
    await page.locator('.ms-cell').nth(50).click();
    await expect.poll(() => readMs(page).then(s => s.revealed), { timeout: 6000 }).toBeGreaterThan(1);

    const a = await readMs(page);
    checkEq(
      'MS-12-点50',
      { revealed: a.revealed, c8: a.cells[8].cls.includes('ms-revealed'), c11: a.cells[11].cls.includes('ms-revealed'), over: a.over },
      { revealed: 69, c8: false, c11: false, over: false },
    );

    // 8 号（(0,8)，数字 1）与 11 号（(1,2)，数字 4）是两个孤岛：逐个点开才到胜局
    await page.locator('.ms-cell').nth(8).click();
    await expect.poll(() => readMs(page).then(s => s.revealed), { timeout: 6000 }).toBe(70);
    const b = await readMs(page);
    checkEq('MS-12-点8', { revealed: b.revealed, over: b.over }, { revealed: 70, over: false });

    await page.locator('.ms-cell').nth(11).click();
    await expect.poll(() => readMs(page).then(s => s.over), { timeout: 6000 }).toBe(true);
    const c = await readMs(page);
    check('MS-12-点11胜', c.overlayTitle.includes('扫雷成功') && c.revealed === 71, `遮罩="${c.overlayTitle}" 已翻=${c.revealed}`);
  });

  test('MS-13 0 秒成绩：恢复局 elapsed=0 通关 → 遮罩/纪录/存储都是 1 秒；相等不再报新纪录', async ({ page }) => {
    await open(page, '/minesweeper');
    await clearFastest(page);
    await seedSession(page, msSnapshot({ mineIdx: ROW0_MINES, reveal: 'all', leave: 80, elapsed: 0 }));

    await page.locator('.ms-cell').nth(80).click();
    await expect.poll(() => readMs(page).then(s => s.over), { timeout: 6000 }).toBe(true);

    // 方案 A（《35》§2.2）：0 秒只来自"恢复局第一秒内切页"，胜局处钳成 1 秒 —— 否则纪录会被永久锁死在 0
    const sub = ((await page.locator('.ms-overlay-sub').textContent()) || '').trim();
    check('MS-13-遮罩', sub === '新纪录！用时 1 秒', `遮罩副行="${sub}"`);
    await expect.poll(() => bestText(page), { timeout: 6000 }).toContain('最快时间：1 秒');
    await expect.poll(() => storedBest(page), { timeout: 6000 }).toBe('1');

    // 相等不刷新：同一份档再赢一次，盘上已是 1 ⇒ 副行回到「用时 1 秒」，不再报「新纪录！」
    await seedSession(page, msSnapshot({ mineIdx: ROW0_MINES, reveal: 'all', leave: 80, elapsed: 0 }));
    await page.locator('.ms-cell').nth(80).click();
    await expect.poll(() => readMs(page).then(s => s.over), { timeout: 6000 }).toBe(true);

    const sub2 = ((await page.locator('.ms-overlay-sub').textContent()) || '').trim();
    check('MS-13-相等不刷新', sub2 === '用时 1 秒', `第二次遮罩副行="${sub2}"（相等不该刷新纪录）`);
  });
});
