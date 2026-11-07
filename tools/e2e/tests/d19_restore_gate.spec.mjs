// 19：2048 恢复与落盘生命周期（P-006 / P-007 / P-009）
//
// 判据原则：恢复窗口只有毫秒级，**不要在 e2e 里"卡点"点击** —— 那类断言要么恒假绿、要么随机红。
// 只断言"确定性可观测"的三件事：
//   ① 服务端预渲染 HTML 的形态（session-loading + 五个按钮 disabled）—— 确定性快照，不受时序影响；
//   ② 恢复完成后门闸必须解除（防"关不回去"：比 P-006 更严重的倒退是永远点不动）；
//   ③ "看到即已存"：DOM 出现该步之后再刷新，盘面必须保持（await 落盘带来的不变式）。
// 窗口内点击的拦截能力交给 Test/functiontest.mjs 的 FT-08（它用 element.click()，绕得过 disabled）。
import { expect, test } from '@playwright/test';
import {
  check, checkEq, clickDir, open, readBoard, readScore, readSession, simulate, sleep,
} from './helpers.mjs';

/** 盘面签名：16 格按行拼成字符串，用于"是否同一盘面"的精确比对（只比"2 块 0 分"没有判别力） */
const sig = b => b.map(r => r.join(',')).join('|');
const DIRS = ['left', 'down', 'right', 'up'];

const waitSig = (page, s) => expect.poll(async () => sig(await readBoard(page)), { timeout: 7000 }).toBe(s);

/** 等 Blazor 电路就绪（reload 后恢复发生在首次交互渲染，必须先有 Blazor） */
const waitBlazor = page =>
  page.waitForFunction(() => !!window.Blazor, null, { timeout: 15000 }).catch(() => {});

test.describe('19 2048 恢复与落盘生命周期', () => {
  test('G2048-43 预渲染 HTML：容器带 session-loading、五个按钮带 disabled', async ({ page }) => {
    // 直接取服务端返回的原始 HTML —— 预渲染实例的确定性快照，不受时序影响
    const html = await (await page.request.get('/game_2048')).text();
    check(
      'G2048-43-loading类',
      /class="[^"]*\bsession-loading\b/.test(html),
      `预渲染容器类：${(html.match(/class="game-container[^"]*"/) || ['未找到'])[0]}`,
    );

    const btns = [...html.matchAll(/<fluent-button[^>]*>/g)].map(m => m[0]);
    const replay = btns.filter(t => t.includes('replay-btn'));
    const dirs = btns.filter(t => t.includes('dir-btn'));
    check(
      'G2048-43-重玩禁用',
      replay.length >= 1 && replay.every(t => /\bdisabled\b/.test(t)),
      `重玩按钮：${JSON.stringify(replay)}`,
    );
    check(
      'G2048-43-方向键禁用',
      dirs.length === 4 && dirs.every(t => /\bdisabled\b/.test(t)),
      `方向键 ${dirs.length} 个，disabled 数 ${dirs.filter(t => /\bdisabled\b/.test(t)).length}`,
    );
    // P-009 的可见文案：只有半透明而没有提示，用户看到的仍是"分数：0、两块"的假新局
    check('G2048-43-提示行', /class="session-tip"[^>]*>正在恢复对局/.test(html), '预渲染 HTML 应含"正在恢复对局…"提示行');
  });

  test('G2048-44 恢复完成后门闸解除：可点、可走、盘面是残局', async ({ page }) => {
    await open(page, '/game_2048', 1600);
    await clickDir(page, 'left'); // 建立一份真实存档
    const b = await readBoard(page);
    const s = await readScore(page);
    const raw = await readSession(page);
    check(
      'G2048-44-前置',
      raw !== null && JSON.parse(raw).cells.join(',') === b.flat().join(','),
      `走一步后盘面 ${sig(b)}（分数 ${s}）与存档一致`,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitBlazor(page);
    await waitSig(page, sig(b));
    await expect.poll(() => readScore(page), { timeout: 7000 }).toBe(s);

    // 门闸必须回到"已就绪"：否则用户永远点不动（比 P-006 更严重的倒退）
    const st = await page.evaluate(() => ({
      loading: !!document.querySelector('.game-container.session-loading'),
      tip: !!document.querySelector('.session-tip'),
      dis: [...document.querySelectorAll('.controls fluent-button')].map(x => x.disabled === true || x.hasAttribute('disabled')),
      replayDis: (() => {
        const r = document.querySelector('.replay-btn');
        return r.disabled === true || r.hasAttribute('disabled');
      })(),
    }));
    checkEq(
      'G2048-44-门闸',
      { loading: st.loading, tip: st.tip, replayDis: st.replayDis },
      { loading: false, tip: false, replayDis: false },
      '恢复完成后 loading 类 / 提示行 / 禁用态必须全部解除（finally 里置位，任何失败路径都不能卡住）',
    );
    check('G2048-44-方向键', st.dis.length === 4 && st.dis.every(d => d === false), `四方向键禁用态：${JSON.stringify(st.dis)}`);

    // 恢复后仍能正常走子，且存档与画面逐格一致（证明守卫没有误伤主流程、落盘链路仍是活的）
    await clickDir(page, 'right');
    await expect
      .poll(
        async () => {
          const raw = await readSession(page);
          const arch = raw ? JSON.parse(raw).cells.join(',') : 'null';
          return arch === (await readBoard(page)).flat().join(',');
        },
        { timeout: 5000 },
      )
      .toBe(true);
  });

  test('G2048-45 看到即已存：DOM 更新后再刷新，5 轮全保持（P-007 门禁判据）', async ({ page }) => {
    await open(page, '/game_2048', 1600);
    await clickDir(page, 'left'); // 先确保有存档
    const rows = [];

    for (let i = 0; i < 5; i++) {
      if (await page.locator('.game-over').count()) {
        await page.locator('.overlay-replay-btn').click();
        await sleep(600);
      }
      const before = await readBoard(page);
      const beforeSig = sig(before);
      // 挑一个"必然改变棋盘"的方向（与 FT-07 同一手法），否则同步点等不到、判据退化成假绿
      const dir = DIRS.find(d => JSON.stringify(simulate(before, d).board) !== JSON.stringify(before));
      if (!dir) break;
      await clickDir(page, dir);

      // 关键：等到 DOM 真的出现该步结果再刷新（沿用 FT-07 已跑通的 waitForFunction 写法）。
      // 落盘改为 await 后，"DOM 更新"必然晚于 setItem 完成 → 这一步之后刷新必须保持
      const reached = await page
        .waitForFunction(
          s => {
            const t = [...document.querySelectorAll('.game-container .row')]
              .map(r =>
                [...r.querySelectorAll('.tile')].map(x => x.textContent.trim() || '0').join(','),
              )
              .join('|');
            return t && t !== s;
          },
          beforeSig,
          { timeout: 4000 },
        )
        .then(() => true)
        .catch(() => false);

      const mid = await readBoard(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitBlazor(page);
      await waitSig(page, sig(mid));
      rows.push({ i, dir, reached, kept: sig(await readBoard(page)) === sig(mid) });
    }

    check(
      'G2048-45-同步点',
      rows.length === 5 && rows.every(r => r.reached),
      `5 轮都必须观察到 DOM 变化（否则"保持"是假绿的）：${JSON.stringify(rows)}`,
    );
    check('G2048-45', rows.length === 5 && rows.every(r => r.kept), `5 轮明细：${JSON.stringify(rows)}`);
  });
});
