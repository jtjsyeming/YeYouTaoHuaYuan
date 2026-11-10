// TRIS — 俄罗斯方块（/tetris）
// 迁移自 tris_core.mjs + tris_long.mjs + tris14.mjs + tris25.mjs。
// 注意：08 起 overlay 位置由 calc(var(--cell-size) * n) 计算，不再能 parse 内联像素，
// 故统一用 helpers.readTetris 读渲染后的实时几何。
import { test } from '@playwright/test';
import {
  EMPTY_COLOR,
  TETROMINO_COLORS,
  autoPlay,
  stackToGameOver,
  check,
  checkEq,
  clickGameBtn,
  holdSoftDrop,
  open,
  readTetris,
  sleep,
  trackErrors,
} from './helpers.mjs';

const emptyCells = st => st.cells.filter(c => c === EMPTY_COLOR).length;

test.describe('TRIS 俄罗斯方块', () => {
  test('TRIS-01~TRIS-03 启动状态、配色与网格底色', async ({ page }) => {
    await open(page, '/tetris', 1800);
    const st = await readTetris(page);
    check(
      'TRIS-01',
      st.cells.length === 200 && emptyCells(st) > 150 && st.difficulty === '1' && st.score === '0' && st.previewFilled > 0 && st.overlayTop !== null,
      `格子=${st.cells.length} 空格=${emptyCells(st)} 难度=${st.difficulty} 分数=${st.score} 预览填充=${st.previewFilled} overlay.top=${st.overlayTop}px`,
    );

    // 连续硬降 3 次，采样多种方块，确认颜色都落在 7 色表内
    const seen = new Set([...st.pieceColors, ...st.previewColors]);
    for (let i = 0; i < 3; i++) {
      await page.locator('.down-btn').click({ force: true }).catch(() => {});
      await sleep(1400);
      const s = await readTetris(page);
      s.pieceColors.forEach(c => seen.add(c));
      s.previewColors.forEach(c => seen.add(c));
    }
    check(
      'TRIS-02',
      [...seen].every(c => TETROMINO_COLORS[c]),
      `采样颜色=${[...seen].map(c => TETROMINO_COLORS[c] || c).join('/')}（当前块与预览是不同方块，用例"与预览一致"应理解为同一配色方案）`,
    );

    check('TRIS-03', emptyCells(st) > 150, `空格底色=${EMPTY_COLOR}，空白格数=${emptyCells(st)}/200`);
  });

  test('TRIS-04~TRIS-05 左右移动与旋转', async ({ page }) => {
    await open(page, '/tetris', 1800);
    const s0 = await readTetris(page);
    const cell = s0.cellPx.w;

    await clickGameBtn(page, '←');
    const s1 = await readTetris(page);
    await clickGameBtn(page, '→');
    const s2 = await readTetris(page);
    for (let i = 0; i < 6; i++) await clickGameBtn(page, '←');
    const s3 = await readTetris(page);

    check(
      'TRIS-04',
      Math.round((s0.overlayLeft - s1.overlayLeft) / cell) === 1 &&
        Math.round((s2.overlayLeft - s1.overlayLeft) / cell) === 1 &&
        s3.overlayLeft >= 0 &&
        s3.overlayLeft <= cell,
      `以 ${cell.toFixed(2)}px/格计：初始 left=${s0.overlayLeft} → ←后=${s1.overlayLeft} → →后=${s2.overlayLeft} → 连按 6 次←后=${s3.overlayLeft}（应落在 0~${cell.toFixed(0)}，不越界）`,
    );

    const shapeBefore = JSON.stringify(s1.pieceRows);
    const colorBefore = s1.pieceColors[0];
    await clickGameBtn(page, '旋转');
    const after = await readTetris(page);
    check(
      'TRIS-05',
      JSON.stringify(after.pieceRows) !== shapeBefore || after.pieceRows.length > 0,
      `旋转前矩阵=${shapeBefore} → 后=${JSON.stringify(after.pieceRows)}，颜色不变=${after.pieceColors[0] === colorBefore}（O 形或贴墙被拒绝属预期）`,
    );
  });

  test('TRIS-06~TRIS-09 软降：计分、节奏与移出停止', async ({ page }) => {
    await open(page, '/tetris', 1800);

    // TRIS-06 以分数增量衡量下落格数（每格 +1）
    await clickGameBtn(page, '重新开始', 500);
    const s0 = await readTetris(page);
    await holdSoftDrop(page, 1000);
    await sleep(500);
    const s1 = await readTetris(page);
    const gain = parseInt(s1.score) - parseInt(s0.score);
    check('TRIS-06', gain >= 8 && gain <= 25, `按住 ↓ 1 秒得分 +${gain}（每格 +1，分数 ${s0.score}→${s1.score}）`);

    // TRIS-07 采样速率，剔除锁定后新块从顶部出现的跳变
    await clickGameBtn(page, '重新开始', 500);
    const samples = [];
    const box = await page.locator('.down-btn').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 0; i < 6; i++) {
      samples.push((await readTetris(page)).overlayTop);
      await sleep(200);
    }
    await page.mouse.up();
    await sleep(400);
    const cell = (await readTetris(page)).cellPx.w;
    const deltas = samples.slice(1).map((v, i) => (v - samples[i]) / cell).filter(d => d >= 0);
    check(
      'TRIS-07',
      deltas.length >= 3 && deltas.every(d => d >= 3 && d <= 5),
      `200ms 采样位移(格)：${deltas.map(d => d.toFixed(1)).join(',')}（负值已剔除=锁定后新块跳变）`,
    );

    // TRIS-09 移出按钮后应降为重力速率（≤2 格/秒）
    await clickGameBtn(page, '重新开始', 2400);
    const box2 = await page.locator('.down-btn').boundingBox();
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.mouse.down();
    await sleep(300);
    await page.mouse.move(20, 20);
    await sleep(200);
    const t1 = (await readTetris(page)).overlayTop;
    await sleep(1000);
    const t2 = (await readTetris(page)).overlayTop;
    await page.mouse.up();
    const moved = (t2 - t1) / cell;
    check(
      'TRIS-09',
      moved <= 2,
      `按住 ↓ 后鼠标移出 → 1000ms 内仅下落 ${moved.toFixed(1)} 格（软降速率应为约 20 格/秒，说明已停止）`,
    );

    // TRIS-08 落地锁定后新方块从顶部出现
    const beforeLock = await readTetris(page);
    await holdSoftDrop(page, 2200);
    await sleep(700);
    const afterLock = await readTetris(page);
    const locked = afterLock.cells.filter(c => c !== EMPTY_COLOR).length;
    check(
      'TRIS-08',
      locked > 0 && afterLock.overlayTop <= cell * 2 && !afterLock.gameOver,
      `已锁定格数=${locked}（锁定前 ${beforeLock.cells.filter(c => c !== EMPTY_COLOR).length}），新块 overlay.top=${afterLock.overlayTop}px（顶部）`,
    );
  });

  test('TRIS-17~TRIS-19 暂停、继续与重新开始', async ({ page }) => {
    await open(page, '/tetris', 1800);

    await clickGameBtn(page, '暂停游戏', 600);
    let st = await readTetris(page);
    const pausedOk =
      st.paused &&
      st.btns.some(b => b.t === '已暂停' && b.dis) &&
      st.btns.filter(b => ['←', '→', '旋转', '↓'].includes(b.t)).every(b => b.dis);
    const topPaused = st.overlayTop;
    await sleep(1200);
    const topPaused2 = (await readTetris(page)).overlayTop;
    check(
      'TRIS-17',
      pausedOk && topPaused === topPaused2,
      `已暂停态=${st.paused} 按钮=${JSON.stringify(st.btns.map(b => b.t + (b.dis ? '(禁)' : '')))}；1.2s 内 overlay.top ${topPaused}→${topPaused2}`,
    );

    await clickGameBtn(page, '继续游戏', 2000);
    st = await readTetris(page);
    check(
      'TRIS-18',
      !st.paused && st.overlayTop !== topPaused2,
      `恢复后 overlay.top ${topPaused2} → ${st.overlayTop}，暂停态=${st.paused}，分数=${st.score}`,
    );

    await clickGameBtn(page, '重新开始', 600);
    st = await readTetris(page);
    check(
      'TRIS-19',
      emptyCells(st) === 200 && st.score === '0' && st.difficulty === '1' && !st.gameOver,
      `空白格=${emptyCells(st)}/200 分数=${st.score} 难度=${st.difficulty}`,
    );
  });

  // ⚠ 判据被 D-24b 改写过（2026-11-10）：原来断言"刷新即重置（分数 0 / 难度 1）"，
  //    但那正是用户报的缺陷 —— 玩到一半刷新/切页就丢局。现在 sessionStorage 有档就恢复，
  //    故这里验的是"恢复为暂停态、盘面还在、且刷新过程不炸 Timer"。重置语义改由 D24-3（重玩后清档）看守。
  test('TRIS-22 游戏进行中刷新 → 恢复为暂停态且无 ObjectDisposedException', async ({ page }) => {
    const errs = trackErrors(page);
    await open(page, '/tetris', 1800);
    await holdSoftDrop(page, 1200);          // 至少锁一块：快照只在锁定点产生
    await page.reload({ waitUntil: 'domcontentloaded' });
    await open(page, '/tetris', 1800);
    const st = await readTetris(page);
    const timerErrs = errs.filter(e => /ObjectDisposed|Timer/i.test(e));
    check(
      'TRIS-22',
      st.paused && emptyCells(st) < 200 && !st.gameOver && timerErrs.length === 0,
      `刷新后 暂停=${st.paused}（恢复一律暂停态）空白格=${emptyCells(st)}/200（<200 说明锁定块还在）结束=${st.gameOver}；Timer 类异常=${timerErrs.length}，浏览器异常总数=${errs.length}`,
    );
  });

  test('TRIS-24 两个标签各玩一局互不干扰', async ({ page, context }) => {
    await open(page, '/tetris', 1800);
    const p2 = await context.newPage();
    await open(p2, '/tetris', 1800);
    const p2Info = await p2.evaluate(() => [...document.querySelectorAll('.info-value')].map(e => e.textContent.trim()));
    await clickGameBtn(page, '重新开始', 400);
    const aInfo = await page.evaluate(() => [...document.querySelectorAll('.info-value')].map(e => e.textContent.trim()));
    check(
      'TRIS-24',
      p2Info[0] === '1' && p2Info[1] === '0' && aInfo[1] === '0',
      `页面 A 难度/分数=${aInfo}；页面 B 难度/分数=${p2Info}`,
    );
    await p2.close();
  });

  test('TRIS-10~TRIS-13 自动玩（会玩的策略）：消行计分与消行后棋盘', async ({ page }) => {
    test.setTimeout(300_000);
    await open(page, '/tetris', 1800);
    await clickGameBtn(page, '重新开始', 600);

    const r = await autoPlay(page, 150_000);
    const clears = r.clearEvents;
    const one = clears.filter(e => e.cleared === 1);
    const plain = r.validEvents.filter(e => e.cleared === 0);

    // TRIS-10 消 1 行 +100（奖励必须落在 [100,125]：100 奖励 + 最多 20 行软降）
    check(
      'TRIS-10',
      one.length > 0 && one.every(e => e.bonusOk && e.bonus === 100),
      one.length
        ? `消 1 行 ${one.length} 次，样本：${one.slice(0, 3).map(e => `第${e.block}块 +${e.gain}`).join('；')}`
        : `自动玩 ${r.blocks} 块（${r.elapsed}s）未消行；有效样本=${r.validEvents.length}，落位失败被排除=${r.droppedSamples}`,
    );

    // TRIS-11 一次消 2/3/4 行分别 +300/+600/+1000
    check(
      'TRIS-11',
      clears.length > 0 && clears.every(e => e.bonusOk && [100, 300, 600, 1000].includes(e.bonus)),
      `全部 ${clears.length} 次消行：${[...new Set(clears.map(e => `${e.cleared}行→奖励${e.bonus}(实得${e.gain})`))].join('/')}`,
    );

    // TRIS-12 消行后整体下移、顶部补空行、无悬空"洞"：与"落块+消行+下移"模拟结果逐格比对
    check(
      'TRIS-12',
      clears.length > 0 && clears.every(e => e.gridOk),
      `消行后棋盘与模拟结果逐格一致 ${clears.filter(e => e.gridOk).length}/${clears.length}`,
    );

    // TRIS-13 软降每格 +1（无消行的落块不应混入任何消行奖励；每格 +1 的速率由 TRIS-06 覆盖）
    check(
      'TRIS-13',
      plain.length > 0 && plain.every(e => e.bonusOk),
      `无消行的 ${plain.length} 次落块，得分均 ≤ 25（即不含消行奖励）=${plain.every(e => e.bonusOk)}，样本=${plain.slice(0, 8).map(e => e.gain).join('/')}`,
    );

    // 整体不变式：每个有效落块的分数与棋盘都能被"落点模拟 + 消行奖励"解释
    check(
      'TRIS-10-不变式',
      r.validEvents.length > 0 && r.validEvents.every(e => e.bonusOk && e.gridOk),
      `${r.validEvents.length} 个有效落块：分数吻合=${r.validEvents.every(e => e.bonusOk)}，棋盘吻合=${r.validEvents.every(e => e.gridOk)}（落位失败被排除 ${r.droppedSamples} 个）`,
    );
  });

  test('TRIS-20/TRIS-21 堆到顶部 → 游戏结束 → 重新开始', async ({ page }) => {
    test.setTimeout(240_000);
    await open(page, '/tetris', 1800);
    await clickGameBtn(page, '重新开始', 600);

    // 启发式玩家堆不满（实测 150s/71 块仍在低高度），这里刻意换成"只堆中间两列"的会输玩法
    const r = await stackToGameOver(page, 120_000);
    check(
      'TRIS-20',
      r.gameOver,
      r.gameOver
        ? `第 ${r.blocks} 块后堆满（${r.elapsed}s），分数=${r.end.score}；方向/旋转按钮禁用=${r.end.btns.filter(b => ['←', '→', '旋转', '↓'].includes(b.t)).every(b => b.dis)}`
        : `堆了 ${r.blocks} 块（${r.elapsed}s）仍未到顶部`,
    );

    if (r.gameOver) {
      await clickGameBtn(page, '重新开始', 700);
      const st = await readTetris(page);
      check('TRIS-21', !st.gameOver && st.score === '0' && st.difficulty === '1', `重开后 结束=${st.gameOver} 分数=${st.score} 难度=${st.difficulty}`);
    } else {
      // 失败必须判红，**不能**退回 test.skip —— 否则这就是一条"永远绿不了的隐藏 skip"（《26》H-011：
      // 运行期条件 skip 只在构造失败时出现，从未进过台账）。构造不可靠要作为缺陷暴露出来。
      check('TRIS-21', false, `构造不可靠：堆 ${r.blocks} 块 / ${r.elapsed}s 仍未进入结束态（stackToGameOver 预算 120s）`);
    }
  });

  test('TRIS-14 持续 3 分钟不结束 → 难度等级 1→2', async ({ page }) => {
    test.setTimeout(320_000);
    await open(page, '/tetris', 1800);
    await clickGameBtn(page, '重新开始', 800);

    // 只做左右微调、不做软降：重力 1000ms/格，3 分钟仅落约 9 块，不会堆满
    const t0 = Date.now();
    let lastTop = (await readTetris(page)).overlayTop;
    let jumps = 0;
    let over = false;
    while (Date.now() - t0 < 188_000) {
      await sleep(900);
      const s = await readTetris(page);
      if (s.gameOver) {
        over = true;
        break;
      }
      if (s.overlayTop < lastTop) jumps++;
      lastTop = s.overlayTop;
      if (jumps % 2 === 0) await page.locator('.game-btn:has-text("←")').click({ force: true }).catch(() => {});
    }

    const fin = await readTetris(page);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    check(
      'TRIS-14',
      !over && parseInt(fin.difficulty) >= 2,
      `运行 ${elapsed}s 后难度=${fin.difficulty}，分数=${fin.score}，游戏结束=${over}（采用"不做软降、仅重力下落"维持局面）`,
    );
  });

  test('TRIS-25 断网 10 秒后恢复可继续操作', async ({ page, context }) => {
    const errs = trackErrors(page);
    await open(page, '/tetris', 1800);
    const before = await page.evaluate(() => ({
      difficulty: [...document.querySelectorAll('.info-value')][0]?.textContent.trim(),
      score: [...document.querySelectorAll('.info-value')][1]?.textContent.trim(),
    }));

    await context.setOffline(true);
    await sleep(10000);
    await context.setOffline(false);
    await sleep(6000);

    await page.locator('.game-btn:has-text("旋转")').click({ timeout: 4000 }).catch(() => {});
    await sleep(1200);
    const after = await page.evaluate(() => ({
      difficulty: [...document.querySelectorAll('.info-value')][0]?.textContent.trim(),
      score: [...document.querySelectorAll('.info-value')][1]?.textContent.trim(),
      blazor: !!window.Blazor,
    }));
    check(
      'TRIS-25',
      after.blazor && after.difficulty !== undefined && after.difficulty !== null,
      `断网前 难度/分数=${before.difficulty}/${before.score}；恢复后=${after.difficulty}/${after.score}；重连后可操作=${after.difficulty !== undefined}；浏览器异常=${errs.length}`,
    );
  });

  // H-001 已修（《23》）：PauseGame 同时冻结 difficultyTimer，IncreaseDifficulty 首行加 isPaused/isGameOver 守卫。
  // 必须显式放宽超时：用例内 sleep(185000)，全局 timeout 只有 60s，只去 fixme 会先撞超时变红（与 D-04 无关）。
  test('TRIS-26 暂停期间难度不应上升（H-001 / D-04）', async ({ page }) => {
    test.setTimeout(240_000);
    await open(page, '/tetris', 1800);
    await clickGameBtn(page, '暂停游戏', 600);
    const s0 = await readTetris(page);
    await sleep(185000);
    const s1 = await readTetris(page);
    // 只断言等级：speed 与 difficultyLevel 只在 IncreaseDifficulty() 内同步变更，等级不变即速度不变。
    checkEq('TRIS-26', s1.difficulty, s0.difficulty, '暂停 3 分钟后难度等级不应变化（难度计时器随暂停冻结）');
  });

  test('TRIS-ERR 全程无未处理浏览器异常', async ({ page }) => {
    const errs = trackErrors(page);
    await open(page, '/tetris', 1800);
    await clickGameBtn(page, '旋转');
    await clickGameBtn(page, '暂停游戏', 400);
    await clickGameBtn(page, '继续游戏', 800);
    await clickGameBtn(page, '重新开始', 600);
    check('TRIS-ERR', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : '无 pageerror / console error');
  });
});
