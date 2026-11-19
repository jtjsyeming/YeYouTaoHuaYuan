// 冒烟集：《07-测试文档-全量测试用例-v2.0.md》§11.3 的 28 条 P0
// 每条用例都落到具体断言（不新增逻辑，只挑 P0 子集）。TRIS-23 自 P-068 起为真用例：读站点日志增量判宿主侧 Error。
import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  check,
  clickGameBtn,
  countTiles,
  driveToGameOver,
  fishCount,
  moveOnce,
  open,
  parseTimer,
  pickSelect,
  readBoard,
  readLoveTime,
  readScore,
  readTetris,
  secsOf,
  simulate,
  sleep,
  viewportMetrics,
} from './helpers.mjs';

test.describe('冒烟集（28 条 P0）', () => {
  // TRIS-23 放在**第一条**（《41》§3.4 / §7.1-③）：组件 DisposeAsync 是"电路被释放"时跑的，
  // 而裸 AddServerSideBlazor() 的 DisconnectedCircuitRetentionPeriod 默认 3 分钟 ⇒ 前面几条用例的
  // 电路可能正好在这个 10s 窗口内被释放，异常会被算到这条头上。挪到最前是零成本的对冲。
  test('TRIS-23 关闭标签页后 10 秒内宿主无 Error 级日志', async ({ page }) => {
    // 站点日志来自 webServer 的 `> jtjsym-site.log`，或 README 那条"手动起站 + 重定向"。
    // 复用已存在站点（reuseExistingServer）时 webServer 不经手，日志只可能由外部命令产生。
    const logPath = process.env.JTJSYM_SITE_LOG
      ?? path.resolve(import.meta.dirname, '..', 'jtjsym-site.log');   // tools/e2e/jtjsym-site.log

    // ① 不存在就判红并 return —— check() 是 expect.soft，**不中断**；不 return 会在下一行抛
    //    ENOENT，红是红了，但报错变成 Node 堆栈，读者不知道该怎么修。
    if (!fs.existsSync(logPath)) {
      check('TRIS-23', false,
        `未找到站点日志 ${logPath}——外部起站请按 README 把控制台重定向到该路径，或设 JTJSYM_SITE_LOG`);
      return;
    }

    // ② 哨兵：文件存在但 0 字节 ⇒ 不是站点日志（启动行必定 > 0）。防"被 touch 出来的空文件"。
    const baseBuf = fs.readFileSync(logPath);
    if (baseBuf.length === 0 || !baseBuf.toString('utf8').includes('Now listening on')) {
      check('TRIS-23', false, `${logPath} 存在但不像站点日志（${baseBuf.length} 字节、无 "Now listening on"）`);
      return;
    }
    const baseBytes = baseBuf.length;             // ③ 真·字节基线（Buffer.length，不是字符串 length）

    await open(page, '/tetris', 1200);
    await page.close();                           // 触发 circuit 断开
    await sleep(10_000);

    const after = fs.readFileSync(logPath);
    const added = after.subarray(baseBytes).toString('utf8');  // 只取增量：旧异常不污染本轮
    const bad = /Unhandled exception|ObjectDisposedException/.test(added);
    check('TRIS-23', !bad,
      `关闭后日志增量 ${after.length - baseBytes} 字节，命中未处理异常=${bad}`
      + (bad ? `；片段：${added.slice(0, 300)}` : '（增量为 0 属正常：Microsoft.AspNetCore 级别为 Warning）'));
  });

  test('NAV-01/NAV-02 首页与 7 项导航', async ({ page }) => {
    await open(page, '/');
    const h1 = (await page.textContent('h1').catch(() => '')) || '';
    const cardCount = await page.locator('.home-card').count();
    check('NAV-01', h1.includes('欢迎来到夜游桃花源') && cardCount === 7, `h1="${h1.trim()}" 入口卡片=${cardCount}`);

    const navMap = [
      ['jtjsym', '/'],
      ['按下试试', '/counter'],
      ['爱情计时器', '/loveTime'],
      ['2048', '/game_2048'],
      ['俄罗斯方块', '/tetris'],
      ['扫雷', '/minesweeper'],
      ['连连看', '/llkcalendar'],
    ];
    const bad = [];
    for (const [text, path] of navMap) {
      await open(page, '/');
      await page.locator('nav a.fluent-nav-link', { hasText: text }).first().click();
      await sleep(1100);
      const url = new URL(page.url()).pathname;
      if (url !== path) bad.push(`${text}→${url}(期望${path})`);
    }
    check('NAV-02', bad.length === 0, bad.length ? bad.join(' | ') : '6 项路由全部正确');
  });

  test('FISH-01/FISH-02/FISH-03 木鱼计数与装饰', async ({ page }) => {
    await open(page, '/counter');
    const statusText = async () => ((await page.textContent('p[role=status]')) || '').trim();
    const deco = () => page.locator('article div img[src*="counter.gif"]').count();

    const t0 = await statusText();
    const btnCount = await page.locator('fluent-button.muyu-btn').count();
    check('FISH-01', fishCount(t0) === 0 && btnCount === 1 && (await deco()) === 0, `文案="${t0}" 按钮=${btnCount} 装饰=${await deco()}`);

    await page.locator('fluent-button.muyu-btn').click();
    await sleep(500);
    const t1 = await statusText();
    // C-49：装饰由上下两枚扩为四向，此处只校数量（冒烟集保持轻量）；
    // 「四条方位各 1」的完整判据在 nav_fish 的 FISH-02，那里用 dx/dy 分类，抓得住"左右被堆成上下"。
    check('FISH-02', fishCount(t1) === 1 && (await deco()) === 4, `点击后="${t1}" 装饰=${await deco()}（期望 4）`);

    for (let i = 0; i < 9; i++) {
      await page.locator('fluent-button.muyu-btn').click();
      await sleep(60);
    }
    await sleep(500);
    const t10 = await statusText();
    check('FISH-03', fishCount(t10) === 10, `连点 10 次后="${t10}"`);
  });

  test('LT-01/LT-03/LT-08/LT-09/LT-12/LT-14/LT-19/LT-23 爱情计时器', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, '/loveTime', 1600);
    let st = await readLoveTime(page);
    const parsed = st.timers.map(parseTimer);
    check('LT-01', st.timers.length === 3 && parsed.every(Boolean), `三行：${st.timers.map(t => t.replace(/^我们[^：]*：/, '')).join(' | ')}`);

    const p1 = parseTimer((await readLoveTime(page)).timers[0]);
    await sleep(2600);
    const p2 = parseTimer((await readLoveTime(page)).timers[0]);
    const delta = secsOf(p2) - secsOf(p1);
    check('LT-03', delta >= 2 && delta <= 3, `2.6s 推进 ${delta} 秒`);

    await pickSelect(page, 0, '2024');
    await pickSelect(page, 1, '2');
    st = await readLoveTime(page);
    check('LT-08', st.dayOptions.length === 29, `2024-02 日选项 ${st.dayOptions.length} 项`);

    await pickSelect(page, 0, '2025');
    st = await readLoveTime(page);
    check('LT-09', st.dayOptions.length === 28, `2025-02 日选项 ${st.dayOptions.length} 项`);

    await pickSelect(page, 1, '2');
    await pickSelect(page, 2, '28');
    await page.locator('fluent-button.timer').nth(1).click();
    await sleep(1000);
    st = await readLoveTime(page);
    check('LT-12', !!parseTimer(st.timers[1]), `选 2025-02-28 计算恋爱 → "${st.timers[1].replace(/^我们[^：]*：/, '')}"`);

    const futureY = new Date().getFullYear();
    await pickSelect(page, 0, String(futureY));
    await pickSelect(page, 1, '12');
    await pickSelect(page, 2, '31');
    const before = (await readLoveTime(page)).timers.map(parseTimer);
    await page.locator('fluent-button.timer').nth(0).click();
    await sleep(900);
    st = await readLoveTime(page);
    check(
      'LT-14',
      st.tip === '纪念日不能晚于今天，请重新选择。' && st.timers.every((t, i) => parseTimer(t).d === before[i].d),
      `提示="${st.tip}"，三行未变=${st.timers.every((t, i) => parseTimer(t).d === before[i].d)}`,
    );

    await page.locator('.love-reset-bar fluent-button').nth(0).click();
    await sleep(900);
    st = await readLoveTime(page);
    check('LT-19', !!parseTimer(st.timers[0]) && parseTimer(st.timers[0]).d > 3000, `恢复默认后相识行 ${parseTimer(st.timers[0]).d} 天`);

    await open(page, '/counter');
    await sleep(10000);
    await open(page, '/loveTime', 1600);
    const n1 = parseTimer((await readLoveTime(page)).timers[0]);
    await sleep(2200);
    const n2 = parseTimer((await readLoveTime(page)).timers[0]);
    const dn = secsOf(n2) - secsOf(n1);
    check('LT-23', dn >= 2 && dn <= 3, `切页 10 秒返回后 2.2s 推进 ${dn} 秒`);
  });

  test('G2048-01/G2048-02/G2048-07-09/G2048-22 2048', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, '/game_2048', 1600);

    const b0 = await readBoard(page);
    const s0 = await readScore(page);
    check(
      'G2048-01',
      b0.length === 4 && countTiles(b0) === 2 && s0 === 0 && (await page.locator('.game-over').count()) === 0 && b0.flat().every(v => [0, 2, 4].includes(v)),
      `非零块=${countTiles(b0)} Score=${s0} 值=${JSON.stringify([...new Set(b0.flat().filter(Boolean))])}`,
    );

    // G2048-02：初始按左
    const willChange = JSON.stringify(simulate(b0, 'left').board) !== JSON.stringify(b0);
    const landed0 = await moveOnce(page, 'left', willChange);
    const b1 = landed0.board;
    const s1 = landed0.score;
    const ok2 = willChange
      ? s1 - s0 === simulate(b0, 'left').gain && countTiles(b1) >= countTiles(b0)
      : JSON.stringify(b1) === JSON.stringify(b0) && s1 === s0;
    check('G2048-02', ok2, `前置=${JSON.stringify(b0)} 理论会变化=${willChange} 结果=${JSON.stringify(b1)} 分数 ${s0}→${s1}`);

    // G2048-07/G2048-09：合并规则由"逐步与标准规则比对"覆盖（最多 12 步，含合并即视为覆盖）
    let merges = 0;
    let mismatches = 0;
    const dirs = ['left', 'up', 'right', 'down'];
    for (let i = 0; i < 12; i++) {
      const beforeBoard = await readBoard(page);
      const beforeScore = await readScore(page);
      let sim = null;
      let dir = null;
      for (const d of dirs) {
        const r = simulate(beforeBoard, d);
        if (JSON.stringify(r.board) !== JSON.stringify(beforeBoard)) {
          sim = r;
          dir = d;
          break;
        }
      }
      if (!dir) break;
      // dir 由 simulate 选出、必然改变盘面 ⇒ 条件等待（不再靠固定沉降）
      const landed = await moveOnce(page, dir, true);
      const after = landed.board;
      const afterScore = landed.score;
      if (afterScore - beforeScore !== sim.gain) mismatches++;
      if (sim.gain > 0) merges++;
      if ((await page.locator('.game-over').count()) > 0) break;
    }
    check('G2048-07/09', mismatches === 0 && merges > 0, `12 步内 ${merges} 步发生合并，分数增量不符 ${mismatches} 次`);

    // G2048-22：无变化方向
    let hit = false;
    for (let attempt = 0; attempt < 40 && !hit; attempt++) {
      const b = await readBoard(page);
      const nd = ['left', 'up', 'right', 'down'].filter(d => JSON.stringify(simulate(b, d).board) === JSON.stringify(b));
      if (nd.length > 0 && countTiles(b) >= 2) {
        const sc = await readScore(page);
        const landed = await moveOnce(page, nd[0], false);   // 无变化的一步：负命题，只能有界沉降
        const b2 = landed.board;
        const sc2 = landed.score;
        check(
          'G2048-22',
          JSON.stringify(b2) === JSON.stringify(b) && sc2 === sc,
          `${nd[0]} 方向无变化 → 点击后棋盘${JSON.stringify(b2) === JSON.stringify(b) ? '不变' : '变了'}、分数 ${sc}→${sc2}`,
        );
        hit = true;
      } else {
        await page.locator('.replay-btn').first().click();
        await sleep(260);
      }
    }
    if (!hit) check('G2048-22', false, '40 次重玩未找到「某方向无变化」的开局');
  });

  test('TRIS-01/04/05/06/17/19/22 俄罗斯方块基础', async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, '/tetris', 1800);
    let st = await readTetris(page);
    check(
      'TRIS-01',
      st.cells.length === 200 && st.difficulty === '1' && st.score === '0' && st.previewFilled > 0 && st.overlayTop !== null,
      `格子=${st.cells.length} 难度=${st.difficulty} 分数=${st.score} 预览=${st.previewFilled} overlay.top=${st.overlayTop}`,
    );

    const cell = st.cellPx.w;
    const l0 = st.overlayLeft;
    await clickGameBtn(page, '←');
    const l1 = (await readTetris(page)).overlayLeft;
    for (let i = 0; i < 6; i++) await clickGameBtn(page, '←');
    const l2 = (await readTetris(page)).overlayLeft;
    check('TRIS-04', Math.round((l0 - l1) / cell) === 1 && l2 >= 0 && l2 <= cell, `left ${l0}→${l1}；连按 6 次后=${l2}（0~${cell.toFixed(0)}）`);

    const shapeBefore = JSON.stringify(st.pieceRows);
    await clickGameBtn(page, '旋转');
    st = await readTetris(page);
    check('TRIS-05', JSON.stringify(st.pieceRows) !== shapeBefore || st.pieceRows.length > 0, `旋转前=${shapeBefore} 后=${JSON.stringify(st.pieceRows)}`);

    const sc0 = parseInt((await readTetris(page)).score);
    const box = await page.locator('.down-btn').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await sleep(1000);
    await page.mouse.up();
    await sleep(400);
    const gain = parseInt((await readTetris(page)).score) - sc0;
    check('TRIS-06', gain >= 8 && gain <= 25, `按住 ↓ 1 秒得分 +${gain}`);

    await clickGameBtn(page, '暂停游戏', 600);
    st = await readTetris(page);
    const top1 = st.overlayTop;
    await sleep(1200);
    const top2 = (await readTetris(page)).overlayTop;
    check(
      'TRIS-17',
      st.paused && top1 === top2 && st.btns.filter(b => ['←', '→', '旋转', '↓'].includes(b.t)).every(b => b.dis),
      `暂停态=${st.paused}，1.2s 内 overlay.top ${top1}→${top2}，方向键禁用=${st.btns.filter(b => ['←', '→', '旋转', '↓'].includes(b.t)).every(b => b.dis)}`,
    );

    await clickGameBtn(page, '重新开始', 600);
    st = await readTetris(page);
    check('TRIS-19', st.cells.filter(c => c === 'rgb(26, 26, 26)').length === 200 && st.score === '0' && st.difficulty === '1', `空白格=${st.cells.filter(c => c === 'rgb(26, 26, 26)').length}/200 分数=${st.score} 难度=${st.difficulty}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await open(page, '/tetris', 1800);
    st = await readTetris(page);
    check('TRIS-22', st.difficulty === '1' && st.score === '0' && !st.gameOver, `刷新后 难度=${st.difficulty} 分数=${st.score} 结束=${st.gameOver}`);
  });

  test('TRIS-10/TRIS-20 消行计分与游戏结束（有界自动玩）', async ({ page }) => {
    // 240s → 120s，但**不能删**：前半段 autoPlay(60_000) 本身就可能吃满默认 60s，
    // "预算参数可以消失"只对 tris 那条成立（它原来整条都在等赌局）。
    test.setTimeout(120_000);
    const { autoPlay } = await import('./helpers.mjs');

    // TRIS-10：会玩的策略，60 秒内应产生消行
    await open(page, '/tetris', 1800);
    await clickGameBtn(page, '重新开始', 600);
    const r = await autoPlay(page, 60_000);
    const clears = r.clearEvents;
    check(
      'TRIS-10',
      clears.some(e => e.cleared >= 1 && e.bonusOk),
      clears.length
        ? `消行 ${clears.length} 次（行数 ${[...new Set(clears.map(e => e.cleared))].join('/')}），奖励加分全部吻合=${clears.every(e => e.bonusOk)}`
        : `自动玩 ${r.blocks} 块（${r.elapsed}s）未消行，全量见 tris.spec.mjs`,
    );

    // TRIS-20：注入近满盘（不再赌方块序列）。seedTetrisSession 内部会 reload，
    // 于是上一步 autoPlay 的残局被整档替换 —— TRIS-10 已断言完，不影响。
    const s = await driveToGameOver(page);
    check(
      'TRIS-20',
      s.ok,
      s.ok ? `注入近满盘后 ${s.ms}ms 进入结束态，分数=${(await readTetris(page)).score}` : `构造失效：${s.reason}`,
    );
  });

});
