// LT — 爱情计时器（/loveTime）
// 迁移自 lt.mjs，26 条断言（LT-01~LT-24 + LT-ERR）合并为按场景划分的 test()。
import { test } from '@playwright/test';
import { check, checkEq, open, sleep, trackErrors } from './helpers.mjs';

const readState = page =>
  page.evaluate(() => {
    const sels = [...document.querySelectorAll('fluent-select')];
    const opts = i => [...sels[i].querySelectorAll('fluent-option')].map(o => o.textContent.trim());
    return {
      y: sels[0].value,
      m: sels[1].value,
      d: sels[2].value,
      yearCount: opts(0).length,
      yearFirst: opts(0)[0],
      yearLast: opts(0).slice(-1)[0],
      monthCount: opts(1).length,
      monthFirst: opts(1)[0],
      monthLast: opts(1).slice(-1)[0],
      dayOptions: opts(2),
      timers: [...document.querySelectorAll('div.timer')].map(t => t.textContent.trim()),
      tip: document.querySelector('.love-validation-tip')?.textContent.trim() || null,
      resetBtns: [...document.querySelectorAll('.love-reset-bar fluent-button')].map(b => b.textContent.trim()),
      calcBtns: [...document.querySelectorAll('fluent-button.timer')].map(b => b.textContent.trim()),
    };
  });

// FluentSelect 不能靠"赋 value + 派发 change"驱动 Blazor，必须点击展开后点 fluent-option
async function pick(page, idx, text) {
  await page.locator('fluent-select').nth(idx).click({ force: true });
  await sleep(420);
  const ok = await page.evaluate(
    ({ idx, text }) => {
      const s = document.querySelectorAll('fluent-select')[idx];
      const o = [...s.querySelectorAll('fluent-option')].find(x => x.textContent.trim() === text);
      if (!o) return false;
      o.click();
      return true;
    },
    { idx, text },
  );
  await sleep(850);
  return ok;
}

async function setDate(page, y, m, d) {
  await pick(page, 0, String(y));
  await pick(page, 1, String(m));
  await pick(page, 2, String(d));
}

const calcBtn = (page, i) => page.locator('fluent-button.timer').nth(i);
const resetBtn = (page, i) => page.locator('.love-reset-bar fluent-button').nth(i);

function parseTimer(s) {
  const m = /(\d+)\s*天,\s*(\d+)\s*小时,\s*(\d+)\s*分钟,\s*(\d+)\s*秒/.exec(s || '');
  return m ? { d: +m[1], h: +m[2], mi: +m[3], s: +m[4] } : null;
}

const today = new Date();
const daysBetween = (y, m, d) => {
  const pad = n => String(n).padStart(2, '0');
  const nowIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T00:00:00+08:00`;
  const thenIso = `${y}-${pad(m)}-${pad(d)}T00:00:00+08:00`;
  return Math.floor((Date.parse(nowIso) - Date.parse(thenIso)) / 86400000);
};
const secsOf = p => p.mi * 60 + p.s;

test.describe('LT 爱情计时器', () => {
  test('LT-01~LT-07 三行展示、秒级刷新与下拉选项', async ({ page }) => {
    await open(page, '/loveTime', 1600);
    const st = await readState(page);

    const expectDates = [
      ['meet', 2018, 4, 22],
      ['love', 2022, 2, 25],
      ['married', 2023, 8, 8],
    ];
    const parsed = st.timers.map(parseTimer);
    check('LT-01', st.timers.length === 3 && parsed.every(Boolean), `三行文本：${st.timers.join(' | ')}`);

    const diffs = parsed.map((p, i) => {
      const [, y, m, d] = expectDates[i];
      return `${['相识', '相爱', '结婚'][i]} 页面${p && p.d} vs 实际${daysBetween(y, m, d)}`;
    });
    check(
      'LT-02',
      parsed.every((p, i) => Math.abs(p.d - daysBetween(expectDates[i][1], expectDates[i][2], expectDates[i][3])) <= 1),
      diffs.join('；'),
    );

    const p1 = parseTimer((await readState(page)).timers[0]);
    await sleep(2600);
    const p2 = parseTimer((await readState(page)).timers[0]);
    const delta = secsOf(p2) - secsOf(p1);
    check('LT-03', delta >= 2 && delta <= 3, `2.6s 内秒数推进 ${delta} 秒（${p1.mi}分${p1.s}秒 → ${p2.mi}分${p2.s}秒）`);

    checkEq('LT-05', [st.yearCount, st.yearFirst, st.yearLast, st.y], [today.getFullYear() - 1950 + 1, '1950', String(today.getFullYear()), '1950'], '年份下拉');
    checkEq('LT-06', [st.monthCount, st.monthFirst, st.monthLast, st.m], [12, '1', '12', '1'], '月份下拉');
    checkEq('LT-07', [st.dayOptions.length, st.dayOptions[0], st.dayOptions[30], st.d], [31, '1', '31', '1'], '日期下拉（1950-01）');

    check('LT-CALCBTN', st.calcBtns.length === 3 && st.resetBtns.length === 3, `计算按钮=${st.calcBtns.length} 恢复按钮=${st.resetBtns.length}（P1 恢复默认）`);
  });

  test('LT-08~LT-13 年月日联动、闰月与非法日收敛', async ({ page }) => {
    await open(page, '/loveTime', 1600);

    await pick(page, 0, '2024');
    await pick(page, 1, '2');
    let st = await readState(page);
    check('LT-08', st.dayOptions.length === 29 && st.dayOptions[28] === '29', `2024-02 日选项 ${st.dayOptions.length} 项，末项=${st.dayOptions.at(-1)}`);

    await pick(page, 1, '3');
    await pick(page, 0, '2025');
    await pick(page, 1, '2');
    st = await readState(page);
    check('LT-09', st.dayOptions.length === 28, `2025-02 日选项 ${st.dayOptions.length} 项`);

    await pick(page, 1, '4');
    st = await readState(page);
    check('LT-10', st.dayOptions.length === 30, `2025-04 日选项 ${st.dayOptions.length} 项`);

    await pick(page, 1, '1');
    await pick(page, 2, '31');
    const beforeSwitch = await readState(page);
    await pick(page, 1, '2');
    st = await readState(page);
    check(
      'LT-11',
      beforeSwitch.d === '31' && st.d === '28' && st.dayOptions.length === 28,
      `1/31 切 2 月：d=${beforeSwitch.d} → ${st.d}，项数=${st.dayOptions.length}`,
    );

    await pick(page, 1, '2');
    const febOpts = (await readState(page)).dayOptions;
    await pick(page, 1, '4');
    const aprOpts = (await readState(page)).dayOptions;
    check(
      'LT-13',
      !febOpts.includes('30') && !febOpts.includes('31') && aprOpts.includes('30') && !aprOpts.includes('31'),
      `2 月末两项=${febOpts.slice(-2)}；4 月末两项=${aprOpts.slice(-2)}`,
    );
  });

  test('LT-12/LT-04 自选日期立即计算并持续跳动', async ({ page }) => {
    await open(page, '/loveTime', 1600);

    await setDate(page, 2024, 2, 29);
    const beforeCalc = (await readState(page)).timers[1];
    await calcBtn(page, 1).click();
    await sleep(1000);
    let st = await readState(page);
    const p12 = parseTimer(st.timers[1]);
    const expect12 = daysBetween(2024, 2, 29);
    check(
      'LT-12',
      p12 && Math.abs(p12.d - expect12) <= 1 && st.timers[1] !== beforeCalc,
      `恋爱行=${st.timers[1].replace(/^我们[^：]*：/, '')}（期望天数≈${expect12}）`,
    );

    const q1 = parseTimer((await readState(page)).timers[1]);
    await sleep(2400);
    const q2 = parseTimer((await readState(page)).timers[1]);
    const dq = secsOf(q2) - secsOf(q1);
    st = await readState(page);
    const meetDays = parseTimer(st.timers[0]).d;
    check('LT-04', dq >= 2 && dq <= 3 && meetDays > 3000, `2.4s 内"相爱"行推进 ${dq} 秒；"相识"行仍为 ${meetDays} 天`);
  });

  test('LT-14/LT-21 未来日期校验与提示清除', async ({ page }) => {
    await open(page, '/loveTime', 1600);

    const futureY = today.getFullYear();
    await setDate(page, futureY, 12, 31);
    const before = (await readState(page)).timers.map(parseTimer);
    await calcBtn(page, 0).click();
    await sleep(900);
    let st = await readState(page);
    const unchanged = st.timers.every((t, i) => parseTimer(t).d === before[i].d);
    check(
      'LT-14',
      st.tip === '纪念日不能晚于今天，请重新选择。' && unchanged && st.timers.every(t => parseTimer(t).d >= 0),
      `提示="${st.tip}"；三行未变=${unchanged}；无负数=${st.timers.every(t => parseTimer(t).d >= 0)}（文档写 2030-01-01，年份下拉上限为当前年，实际不可选）`,
    );

    await pick(page, 1, '11');
    st = await readState(page);
    check('LT-21', st.tip === null, `改月份后提示=${st.tip === null ? '已清空' : '"' + st.tip + '"'}`);
  });

  test('LT-15~LT-18 过去日期、极值日期与连点不叠加', async ({ page }) => {
    await open(page, '/loveTime', 1600);

    await setDate(page, 2000, 1, 1);
    await calcBtn(page, 1).click();
    await sleep(1000);
    let st = await readState(page);
    const p15 = parseTimer(st.timers[1]);
    const expect15 = daysBetween(2000, 1, 1);
    check('LT-15', st.tip === null, `选 2000-01-01 → 提示=${st.tip === null ? '无' : st.tip}；文本=${st.timers[1].replace(/^我们[^：]*：/, '')}`);
    checkEq('LT-16', p15.d, expect15, '天数应等于今天与 2000-01-01 的实际差值');

    await setDate(page, 1950, 1, 1);
    await calcBtn(page, 2).click();
    await sleep(1000);
    st = await readState(page);
    const p17 = parseTimer(st.timers[2]);
    check('LT-17', p17.d > 27000 && p17.d < 29000, `1950-01-01 → ${p17.d} 天（期望 27000~29000，无溢出截断）`);

    for (let i = 0; i < 10; i++) await calcBtn(page, 1).click();
    await sleep(1200);
    const s18a = parseTimer((await readState(page)).timers[1]);
    await sleep(2100);
    const s18b = parseTimer((await readState(page)).timers[1]);
    const d18 = secsOf(s18b) - secsOf(s18a);
    check('LT-18', d18 >= 2 && d18 <= 3, `连点 10 次后 2.1s 推进 ${d18} 秒（定时器未叠加）`);
  });

  test('LT-22 三行秒数一致（RefreshAll 只取一次 Now）', async ({ page }) => {
    await open(page, '/loveTime', 1600);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const ts = (await readState(page)).timers.map(t => parseTimer(t).s);
      samples.push(ts.join('/'));
      await sleep(250);
    }
    const allSame = samples.every(s => {
      const a = s.split('/');
      return a[0] === a[1] && a[1] === a[2];
    });
    check('LT-22', allSame, `5 次采样（相识/相爱/结婚 秒）：${samples.join(' , ')}`);
  });

  test('LT-19/LT-20 一键恢复默认', async ({ page }) => {
    await open(page, '/loveTime', 1600);

    await setDate(page, 2019, 5, 20);
    await calcBtn(page, 0).click();
    await sleep(700);
    await setDate(page, 2019, 6, 21);
    await calcBtn(page, 1).click();
    await sleep(700);
    await setDate(page, 2019, 7, 22);
    await calcBtn(page, 2).click();
    await sleep(900);
    let st = await readState(page);
    const allChanged = st.timers.every(t => {
      const p = parseTimer(t);
      return p.d > 2600 && p.d < 2900;
    });

    await resetBtn(page, 0).click();
    await sleep(900);
    st = await readState(page);
    const p19 = parseTimer(st.timers[0]);
    check(
      'LT-19',
      Math.abs(p19.d - daysBetween(2018, 4, 22)) <= 1 && allChanged,
      `恢复前三行均已偏离=${allChanged}；恢复后相识行 ${p19.d} 天（期望≈${daysBetween(2018, 4, 22)}）`,
    );

    const r1 = parseTimer((await readState(page)).timers[0]);
    await sleep(2200);
    const r2 = parseTimer((await readState(page)).timers[0]);
    const dr = secsOf(r2) - secsOf(r1);
    check('LT-19b', dr >= 1 && dr <= 3, `恢复默认后 2.2s 推进 ${dr} 秒`);

    await resetBtn(page, 1).click();
    await sleep(700);
    await resetBtn(page, 2).click();
    await sleep(900);
    st = await readState(page);
    const p20a = parseTimer(st.timers[1]);
    const p20b = parseTimer(st.timers[2]);
    check(
      'LT-20',
      Math.abs(p20a.d - daysBetween(2022, 2, 25)) <= 1 && Math.abs(p20b.d - daysBetween(2023, 8, 8)) <= 1,
      `相爱 ${p20a.d} 天（期望≈${daysBetween(2022, 2, 25)}）；结婚 ${p20b.d} 天（期望≈${daysBetween(2023, 8, 8)}）`,
    );
  });

  test('LT-23 切页 10 秒返回，速率仍 1 秒/次（无定时器叠加）', async ({ page }) => {
    await open(page, '/loveTime', 1600);
    await open(page, '/counter');
    await sleep(10000);
    await open(page, '/loveTime', 1600);
    const n1 = parseTimer((await readState(page)).timers[0]);
    await sleep(2200);
    const n2 = parseTimer((await readState(page)).timers[0]);
    const dn = secsOf(n2) - secsOf(n1);
    check('LT-23', dn >= 2 && dn <= 3, `返回后 2.2s 推进 ${dn} 秒`);
  });

  test('LT-24 后台标签 30 秒后返回数值仍正确', async ({ page, context }) => {
    test.setTimeout(120_000);
    await open(page, '/loveTime', 1600);
    const bg = await context.newPage();
    await bg.goto('about:blank');
    await bg.bringToFront();
    await sleep(30000);
    await page.bringToFront();
    await sleep(1200);
    const st = await readState(page);
    const p = parseTimer(st.timers[0]);
    check('LT-24', p && p.d > 0 && st.timers.every(t => parseTimer(t)), `切回后 ${st.timers[0].replace(/^我们[^：]*：/, '')}（后台持续渲染属已知 D-08）`);
    await bg.close();
  });

  test('LT-ERR 每秒重渲染期间无未处理 JS 异常', async ({ page }) => {
    const errors = trackErrors(page);
    await open(page, '/loveTime', 1600);
    await sleep(6000);
    await page.locator('fluent-button.timer').first().click();
    await sleep(2000);
    check('LT-ERR', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '无 pageerror / console error');
  });
});
