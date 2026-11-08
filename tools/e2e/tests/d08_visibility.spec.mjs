// D-08：爱情计时器在后台标签下停止每秒推送
// 设计见《24-修复文档-H003-LoveTime后台标签暂停推送-v2.0.md》§4.1
//
// 造后台的手法：document.visibilityState 是 Document.prototype 上的 getter，
// 在 document 实例上 defineProperty 会遮蔽它并立即生效；delete 掉自有属性即还原原型 getter。
// ⚠ 该手法**不会**同步改写 document.hidden —— 所以 wwwroot/js/lovetimer.js 必须读 visibilityState，
//   读 hidden 会让本文件的用例全部假绿。
import { test } from '@playwright/test';
import { check, open, pickSelect, parseTimer, readLoveTime, sleep } from './helpers.mjs';

const ANCHOR_MEET = [2018, 3, 22]; // 内置"相识"纪念日（月从 0 起）

/**
 * 注入/还原可见性并派发 visibilitychange。
 * state=null → 删掉实例上的遮蔽属性，回到原型 getter（headless 下真实值就是 visible）。
 */
const setVisibility = (page, state) =>
  page.evaluate(s => {
    if (s === null) {
      delete document.visibilityState;
    } else {
      Object.defineProperty(document, 'visibilityState', { get: () => s, configurable: true });
    }
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

/** 主行文本 → 距锚点的总秒数（与页面同口径：天/时/分/秒为 TimeSpan 的分量，天不是"每 30 天"） */
const textToSecs = s => {
  const p = parseTimer(s);
  return p ? p.d * 86400 + p.h * 3600 + p.mi * 60 + p.s : null;
};

/** 页面主行文本相对"此刻真实时间"的漂移秒数（正=页面偏新，负=页面偏旧） */
const driftSecs = s => {
  const actual = textToSecs(s);
  if (actual === null) return null;
  const [y, m, d] = ANCHOR_MEET;
  const expect = Math.floor((Date.now() - new Date(y, m, d).getTime()) / 1000);
  return actual - expect;
};

test('D08-1 标签在后台（hidden）：三行秒数必须完全冻结', async ({ page }) => {
  await open(page, '/loveTime', 2200);

  // 对照组：注入前必须能看到秒数在走，否则说明 ticker 根本没跑 —— 后面的"冻结"会恒真
  const alive = [];
  for (let i = 0; i < 3; i++) {
    alive.push((await readLoveTime(page)).timers[0]);
    await sleep(1200);
  }
  check('D08-1-对照', new Set(alive).size >= 2, `注入前 3 次取样应至少变 2 种，实测 ${new Set(alive).size} 种`);

  await setVisibility(page, 'hidden');
  await sleep(1500); // 让 C# 侧 isHidden 落地，并跨过至少 1 个 tick（避免"标志还没生效就被取样"）

  const base = (await readLoveTime(page)).timers;
  const samples = [];
  for (let i = 0; i < 3; i++) {
    await sleep(1200);
    samples.push((await readLoveTime(page)).timers);
  }

  const moved = samples.filter(t => t.join('|') !== base.join('|')).length;
  check(
    'D08-1',
    moved === 0,
    `hidden 期间 3 次取样应与基线完全一致；实测 ${moved}/3 次不同（基线 "${base[0]}"，末次 "${samples.at(-1)[0]}"）`,
  );
});

test('D08-2 回到前台：先补刷到当前时间，再继续每秒刷新', async ({ page }) => {
  await open(page, '/loveTime', 2200);

  await setVisibility(page, 'hidden');
  await sleep(3000); // 冻结 3 秒：不补刷的话恢复瞬间至少落后 3 秒，drift 判据必然抓到
  const frozen = (await readLoveTime(page)).timers[0];

  await setVisibility(page, null);
  await sleep(400); // 只等一个 interop 往返 + 渲染；下一次自然 tick 未必落在窗口内
  const immediate = (await readLoveTime(page)).timers[0];

  const drift = driftSecs(immediate);
  check('D08-2-补刷', drift !== null && Math.abs(drift) <= 2, `恢复后首个取样相对真实时间漂移 ${drift}s（应 ≤2）`);
  check('D08-2-解冻', immediate !== frozen, `恢复后应立刻刷新，实测仍为冻结值 "${frozen}"`);

  // 之后再确认 ticker 真的恢复了（而不是只补刷这一次）
  const next = [];
  for (let i = 0; i < 2; i++) {
    await sleep(1200);
    next.push((await readLoveTime(page)).timers[0]);
  }
  check(
    'D08-2-续走',
    new Set([immediate, ...next]).size >= 2,
    `恢复后 2.4 秒内应继续走秒，实测 ${[immediate, ...next].map(t => `"${t}"`).join(' / ')}`,
  );
});

test('D08-3 后台返回后的年份自愈：列表完整且不重置已选年份', async ({ page }) => {
  await open(page, '/loveTime', 2000);
  await pickSelect(page, 0, '2020');

  await setVisibility(page, 'hidden');
  await sleep(1600);
  await setVisibility(page, null);
  await sleep(1200); // 等 visible 分支的 RefreshAll 渲染完

  const after = await readLoveTime(page);
  const expectYears = new Date().getFullYear() - 1950 + 1;
  check(
    'D08-3-年份',
    after.yearCount === expectYears && after.y === '2020',
    `年份选项 ${after.yearCount} 项（期望 ${expectYears}），已选=${after.y}（期望 2020）`,
  );
  check('D08-3-主行', !!parseTimer(after.timers[0]), `主行应可解析，实测 "${after.timers[0]}"`);
});

// P-026 的用例：页面**一开始就在后台**。此时全程不会发生任何 visibilitychange，
// 只能靠 lovetimer.js 在 register() 里同步一次当前态（否则 ticker 会一直按可见态推帧）。
test('D08-4 初始即 hidden 打开：主行零变化，且恢复 visible 后能继续走秒', async ({ page }) => {
  // 造"初始即后台"必须早于页面脚本（含 blazor.server.js）执行，故用 addInitScript。
  // 与 setVisibility 走同一手法（遮蔽实例上的 getter，configurable 以便后面 delete），
  // 只是时机不同：这里在文档创建前就生效，因此**没有任何事件可依赖**。
  await page.addInitScript(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
  });

  await open(page, '/loveTime', 2200);

  // 判据 1：初始 hidden 期间主行必须冻结
  const base = (await readLoveTime(page)).timers;
  const samples = [];
  for (let i = 0; i < 3; i++) {
    await sleep(1200);
    samples.push((await readLoveTime(page)).timers);
  }
  const moved = samples.filter(t => t.join('|') !== base.join('|')).length;
  check(
    'D08-4-冻结',
    moved === 0,
    `初始 hidden 期间 3 次取样应与基线完全一致；实测 ${moved}/3 次不同（基线 "${base[0]}"，末次 "${samples.at(-1)[0]}"）`,
  );

  // 判据 2（不可省）：恢复 visible 后必须继续走秒。
  // 否则"判据 1 恒真"可能只是因为 ticker 根本没起来（这正是 D08-1 要对照组的原因）。
  await setVisibility(page, null);
  await sleep(400);
  const resumed = [(await readLoveTime(page)).timers[0]];
  for (let i = 0; i < 2; i++) {
    await sleep(1200);
    resumed.push((await readLoveTime(page)).timers[0]);
  }
  check(
    'D08-4-对照',
    new Set(resumed).size >= 2,
    `恢复 visible 后 2.4 秒内应至少出现 2 种文本，实测 ${resumed.map(t => `"${t}"`).join(' / ')}`,
  );
});
