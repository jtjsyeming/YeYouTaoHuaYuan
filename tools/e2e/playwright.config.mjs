import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:14074';
// 发布前清单（release.manual.mjs）默认不收集 —— 它既不占"跳过"数，也不会被误当自动化门禁。
const RELEASE = process.env.PW_RELEASE === '1';
// P-118 §3.1：有外部看护（tools/e2e/site-runner.mjs）时，本 config **完全不碰站点**。
//
// 为什么必须二选一：`url: BASE_URL` + `reuseExistingServer: true` 的组合下，只要 BASE_URL 换成
// 14075 且那一瞬站点没在跑，Playwright 会执行 `command` 起一个 **14074** 的站，然后死等 14075
// 到 `timeout: 180_000` ⇒ 整批红，而且症状是"卡住 3 分钟"而非"port 不对"。
// 更糟的是它会和看护抢同一个日志文件（`>` 截断 ⇒ TRIS-23 的字节基线被清空）。
const SITE_MANAGED = process.env.PW_SITE_MANAGED === '1';

// 连连看每日榜的数据目录（H-018）。
// ⚠ **不能**放 tools/e2e/.tmp/：FT-53 的豁免正则只认 `functiontest.mjs` 与 `.workbuddy/`，
//   而 `.gitignore` 里没有 `.tmp/` ⇒ 跑完 e2e 会留下未跟踪文件 ⇒ FT-53 判红（红在一条与功能无关的守卫上）。
// 用系统临时目录：天然不进工作区，Win/ubuntu 都成立。
// spec 侧按同样的 path.join(os.tmpdir(), 'jtjsym-e2e-llk') 自己算一遍（不 import 本文件 ——
// 两处算的是同一个字符串，靠这条注释互相指向）。
export const LLK_DATA_DIR = path.join(os.tmpdir(), 'jtjsym-e2e-llk');

export default defineConfig({
  testDir: './tests',
  // 默认 undefined = 回到 Playwright 默认 glob。**不要**写成 /.*\.spec\.mjs/：
  // 那会把 .spec.js / .spec.ts 一并排除，属隐性语义收窄 —— 将来"文件在、用例不在"比红更难查。
  // PW_RELEASE=1 时才把 *.manual.mjs 收进来（发布前清单三条）。
  testMatch: RELEASE ? /.*\.(spec|manual)\.mjs/ : undefined,
  timeout: 60_000,
  expect: { timeout: 7_000 }, // Blazor Server 渲染有 SignalR 往返延迟，默认 5s 偏紧
  fullyParallel: false, // 场景脚本内部有状态依赖（LT-10→LT-11、TRIS 连续操作同一局）
  workers: 1, // 单实例 Blazor Server：并行会互相干扰，且与 11-01 基线不可比
  retries: 0, // 计时类断言（秒级跳动 / 难度升级）不允许用重试掩盖抖动
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    // trace 内含逐帧截图：TRIS-14/TRIS-26 单条跑 3 分钟，一次能产 7000+ 文件（实测）。
    // 默认关闭——断言失败信息（expect.soft 的期望/实际）已足够定位；需要逐帧复盘时临时 `--trace on`。
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    viewport: { width: 1400, height: 1000 },
  },
  projects: [
    // NF-01 只在 firefox 有意义、NF-03 只在 chromium 有意义 ⇒ 在**收集期**排除（P-070 类 A）。
    // 跳过是"我不知道该不该跑"，排除是"我知道不该跑"——后者不制造"跳过"计数。
    // ⚠ 这里**只能写被排除的那两条**：grepInvert 是标题正则、对整个项目跨文件生效。
    //   一旦写上 `NF-05`，发布清单 release.manual.mjs 的 `NF-05 http → https` 会被一起吞掉，
    //   而且是"静默排除"（连 skip 都不算），报告里连痕都没有（实测 PW_RELEASE=1 变成 186 而非 187）。
    //   改标题前先 `npx playwright test --list | grep NF-0` 看一眼。
    // 尾空格（`/NF-01 /`）是刻意的：标题是 `NF-01 Firefox 兼容…`，加空格可避免将来 NF-011 被误伤。
    //   **不要用 `\b`** —— `NF-05/07/08` 里 `-05` 与 `/` 之间 `\b` 成立，会误判成词边界。
    { name: 'chromium', grepInvert: /NF-01 /, use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 1000 } } },
    // Firefox 只跑 NF 兼容组（用 testMatch 而非 testIgnore：后者会变成"除冒烟外全跑"）
    { name: 'firefox', testMatch: /code_nf\.spec\.mjs/, grepInvert: /NF-03 /, use: { ...devices['Desktop Firefox'] } },
  ],
  // 缺省时 npm run test:* 会因"站点没起"直接全红；本机无 HTTPS 开发证书，必须显式指定 http 端口
  // ★ ASPNETCORE_ENVIRONMENT 必须是 Development：--no-launch-profile 会跳过 launchSettings，
  //   环境回落为 Production 后 StaticWebAssets 不再从构建输出提供，`_content/Microsoft.Fast.Components.FluentUI/*`
  //   全部 404 → Fluent 自定义元素不会升级，<fluent-option> 以行内元素撑出 2.7~3.1 倍页宽，
  //   所有"横向溢出/尺寸"类断言都会得到假结果（实测见 2026-11-01 D11-D12 执行记录）。
  // PW_SITE_MANAGED=1 ⇒ undefined：Playwright 接受该值，既不启动也不探活（P-118 §3.1 乙方案）。
  webServer: SITE_MANAGED ? undefined : {
    // `> jtjsym-site.log 2>&1` 是 TRIS-23 的验收依据：shell 把两条流都送进文件，
    // 于是 stdout/stderr 维持原样即可（11-13「stdout:'ignore' 让死因不可见」的教训由
    // 这个文件承接，且比 pipe 更持久 —— 跑批结束、进程退了，文件还在）。
    // cwd = 本 config 所在目录 ⇒ 落 tools/e2e/jtjsym-site.log，被既有 `*-site.log` 规则忽略。
    // ⚠ 端口必须跟随 BASE_URL：旧写法写死 14074，配上 `url: BASE_URL` 后会出现
    //   "BASE_URL=14075 但起的是 14074，然后死等 14075 到 180s" 的整批卡死。
    //   有看护时本段整体不生效（SITE_MANAGED），两套启动器不会同时抢端口，故拼 BASE_URL 安全。
    // ⚠ `--project` 用相对本 config 的路径（Playwright 以 config 目录为 cwd），别改成相对仓库根。
    command: `dotnet run --project ../../jtjsym/jtjsym --no-launch-profile --environment Development --urls ${BASE_URL} > jtjsym-site.log 2>&1`,
    url: BASE_URL,
    reuseExistingServer: true, // VS/VS Code 调试实例已占用 14074 时直接复用
    timeout: 180_000,
    // H-018：只写这一个变量即可 —— Playwright 的 env 是**合并**语义
    // （`{ ...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env, ...this._options.env }`，
    // 见 playwright/lib/runner/index.js）。照抄某些文章"把 process.env 全量塞进去"会遮住
    // 以后新增的环境变量，还会让本文件被迫 import process。
    env: { Lianliankan__DataDir: LLK_DATA_DIR },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
