// 发布前验收清单（NF-05 / NF-07 / NF-08）—— 平时**不收集**，不占门禁的"跳过"数。
//
// 收集门控在 playwright.config.mjs 的顶层 testMatch：只有 PW_RELEASE=1 时
// 才会把 *.manual.mjs 收进来。这样它既不制造"跳过"，也不会被误当成自动化门禁的一项。
// 跑法（先指向部署站点）：
//   bash        PW_RELEASE=1 RELEASE_BASE_URL=https://… npx playwright test tests/release.manual.mjs
//   PowerShell  $env:PW_RELEASE='1'; $env:RELEASE_BASE_URL='https://…'; npx playwright test tests/release.manual.mjs
//
// 三条验收项维护口径见《07-测试文档》§9.3「发布前手工清单」；执行结果必须写进发布记录，
// 并注明**实跑时间**（NF-07 的 30 分钟闲置最可能随时间失效）。
import { expect, test } from '@playwright/test';

/** 部署地址，例如 https://jtjsym.example.com（末尾不要带 /） */
const BASE = process.env.RELEASE_BASE_URL;

test.skip(!BASE, '未设置 RELEASE_BASE_URL —— 发布前按《07》§9.3 指向部署站点再跑');

/**
 * 静态资源清单：FluentUI 的 `css/variables.css` 与 `*.bundle.scp.css` 都由该包提供
 * （2026-11-14 在 publish 输出里实测存在）。401/404 会让自定义元素不升级，
 * 表现是"页面能开但控件变形"，比 500 更难发现 —— 所以逐项断言 200。
 */
const STATIC_ASSETS = [
  '/_framework/blazor.server.js',
  '/css/site.css',
  '/_content/Microsoft.Fast.Components.FluentUI/css/variables.css',
  '/_content/Microsoft.Fast.Components.FluentUI/Microsoft.Fast.Components.FluentUI.bundle.scp.css',
];

test('NF-05 http → https 301', async ({ request }) => {
  // 用 http 打一次、不跟随重定向：要验的就是"明文入口被 301/308 送到 https"。
  const plain = BASE.replace(/^https:/, 'http:');
  const r = await request.get(plain, { maxRedirects: 0 });
  expect([301, 308], `明文入口应 301/308，实际 ${r.status()}`).toContain(r.status());
  expect(r.headers()['location'] ?? '', 'Location 必须指向 https').toMatch(/^https:/);
});

test('NF-08 部署站点静态资源 200', async ({ request }) => {
  const bad = [];
  for (const p of STATIC_ASSETS) {
    const st = (await request.get(BASE + p)).status();
    if (st !== 200) bad.push(`${p} → ${st}`);
  }
  expect(bad, `静态资源应全部 200，异常：${bad.join('；')}`).toEqual([]);
});

test('NF-07 闲置 30 分钟重连', async ({ page }) => {
  // 30 分钟不能缩短：默认 DisconnectedCircuitRetentionPeriod 就是 3 分钟，
  // 要验的正是"服务端释放电路之后、浏览器侧再交互"能否重连。
  test.setTimeout(35 * 60_000);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.Blazor, null, { timeout: 30_000 });

  await page.waitForTimeout(30 * 60_000);

  // 判据不能是 `body` 可见 —— **白屏时 body 也存在且可见**，那条断言恒绿，
  // 跑完 30 分钟什么都证明不了，却以"通过"的身份进入账目（比 skip 更糟）。
  // 改盯两件与"渲染是否还活着"强相关的东西：
  //   ① 全局布局节点（nav / h1）仍在且可见 —— 组件树没塌；
  //   ② Blazor 的错误 UI 没被 framework 接管（白屏时它会 display:block）。
  await page.keyboard.press('ArrowLeft'); // 触发重连后的首次交互
  await expect(page.locator('nav'), '闲置后 nav 应仍可见（组件树未塌）').toBeVisible();
  await expect(page.locator('h1'), '闲置后 h1 应仍可见').toBeVisible();

  const errUi = await page.evaluate(() => {
    const el = document.getElementById('blazor-error-ui');
    return el ? getComputedStyle(el).display : 'absent';
  });
  expect(errUi, 'Blazor 错误 UI 不应被接管（display:block 即白屏）').not.toBe('block');
});
