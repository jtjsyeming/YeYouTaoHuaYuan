import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:14074';

export default defineConfig({
  testDir: './tests',
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
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 1000 } } },
    // Firefox 只跑 NF 兼容组（用 testMatch 而非 testIgnore：后者会变成"除冒烟外全跑"）
    { name: 'firefox', testMatch: /code_nf\.spec\.mjs/, use: { ...devices['Desktop Firefox'] } },
  ],
  // 缺省时 npm run test:* 会因"站点没起"直接全红；本机无 HTTPS 开发证书，必须显式指定 http 端口
  // ★ ASPNETCORE_ENVIRONMENT 必须是 Development：--no-launch-profile 会跳过 launchSettings，
  //   环境回落为 Production 后 StaticWebAssets 不再从构建输出提供，`_content/Microsoft.Fast.Components.FluentUI/*`
  //   全部 404 → Fluent 自定义元素不会升级，<fluent-option> 以行内元素撑出 2.7~3.1 倍页宽，
  //   所有"横向溢出/尺寸"类断言都会得到假结果（实测见 2026-11-01 D11-D12 执行记录）。
  webServer: {
    command: 'dotnet run --project ../../jtjsym/jtjsym --no-launch-profile --environment Development --urls http://localhost:14074',
    url: BASE_URL,
    reuseExistingServer: true, // VS/VS Code 调试实例已占用 14074 时直接复用
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
