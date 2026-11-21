#!/usr/bin/env node
// 看护起站脚本（P-118 / C-104）
//
// 为什么要有它（2026-11-20 全量跑批被外部强杀 3 次）：
//   `test:pr` 要跑 19 分钟、全量 30 分钟。这段时间里站点进程一旦死掉（后台任务被回收、
//   另一路会话 `Get-Process jtjsym | Stop-Process`、机器休眠），`workers: 1` 的设计会把
//   "站点死了"放大成"其后每一条用例都红"。CI 有 job 级看护，本机没有 —— 这个脚本就是本机那份。
//
// 三条设计口径（改之前先读《55》§3）：
//   ① **路径一律从脚本自身算**：从仓库根执行与从 tools/e2e 执行必须等价（`--project` 写相对 cwd 会指错目录）。
//   ② **租借按端口一份**：单文件租借会让两个 runner 互相覆盖，两边都以为 14074 是自己的。
//   ③ **连续秒退 5 次就判死因退出**：`--no-build` 未构建、端口被占、路径错都是确定性失败，
//      无上限重启只会把日志涨到几十 MB，然后 TRIS-23 读到一段全是异常的增量、报一条与真实原因无关的红。
//
// 用法（不再需要 `&`）：
//   终端 A：node tools/e2e/site-runner.mjs
//   终端 B：BASE_URL=$(node tools/e2e/site-runner.mjs --print-base) PW_SITE_MANAGED=1 npx playwright test tests/smoke.spec.mjs
//   收工  ：node tools/e2e/site-runner.mjs --stop        # 只杀本机 runner 记录过的 pid
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const E2E_DIR = import.meta.dirname;                                    // …/tools/e2e
const PROJECT = path.resolve(E2E_DIR, '../../jtjsym/jtjsym');           // 绝对路径，与 cwd 无关
const LOG = path.join(E2E_DIR, 'jtjsym-site.log');                      // 与 TRIS-23 同一路径
const LEASE_DIR = path.join(os.tmpdir(), 'jtjsym-e2e');                 // 机器级，不进工作区
const BASE_TXT = path.join(LEASE_DIR, 'base.txt');
// D-43：每日榜数据目录，与 playwright.config.mjs 的 LLK_DATA_DIR、spec 侧同源（三处同一个 path.join）。
// 这里必须**自己注入**：`playwright.config.mjs` 的 `webServer.env` 只在 Playwright 真起站时生效，
// 而 PW_SITE_MANAGED=1 时它完全不碰站点 ⇒ 本文件起的实例就是唯一的站，env 得由本文件给。
const LLK_DATA_DIR = path.join(os.tmpdir(), 'jtjsym-e2e-llk');
const IS_WIN = process.platform === 'win32';

const FIRST_PORT = 14074;
const LAST_PORT = 14086;
const READY_TIMEOUT_MS = 120_000;   // 冷启动 + JIT 在慢机器上确实能到 60s+
const FAST_DEATH_MS = 5_000;        // 活不过 5s 算"秒退"
const FAST_DEATH_LIMIT = 5;         // 连续 5 次秒退 ⇒ 确定性问题，别再重启
const RESTART_DELAY_MS = 2_000;     // 固定 2s，不指数退避：要的是快速自愈
const PRINT_BASE_TIMEOUT_MS = 60_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const argv = process.argv.slice(2);
const hasFlag = f => argv.includes(f);
const argOf = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const say = (...a) => console.error('[site-runner]', ...a);   // 一切诊断走 stderr，stdout 只留 BASE_URL=

// ───────────────────────────── 租借 ─────────────────────────────

const leaseFile = port => path.join(LEASE_DIR, `lease-${port}.json`);

/** 进程是否还活着。用 pid 而不是时间戳判 TTL：休眠唤醒后"未过期却早已死"和"过期却还活着"都会判错。 */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLeases() {
  if (!fs.existsSync(LEASE_DIR)) return [];
  return fs
    .readdirSync(LEASE_DIR)
    .filter(f => /^lease-\d+\.json$/.test(f))
    .map(f => {
      const full = path.join(LEASE_DIR, f);
      try {
        return { file: full, ...JSON.parse(fs.readFileSync(full, 'utf8')) };
      } catch {
        return { file: full, port: Number(/lease-(\d+)/.exec(f)[1]), pid: 0 };
      }
    });
}

const writeLease = (port, pid) => {
  fs.mkdirSync(LEASE_DIR, { recursive: true });
  fs.writeFileSync(leaseFile(port), JSON.stringify({ port, pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');
};

const dropLease = port => {
  try {
    fs.unlinkSync(leaseFile(port));
  } catch {
    /* 已删 */
  }
};

/** 端口是否已被任何进程占用（外来实例 / 另一路 runner 的站都算）。 */
function portBusy(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = v => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(400, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** 挑端口：显式 --port 只认它（被占就报错，调试要确定性）；否则从 14074 往上找空闲的。 */
async function pickPort(preferred) {
  const stale = [];
  const occupied = new Set();
  for (const l of readLeases()) {
    if (pidAlive(l.pid)) occupied.add(l.port);
    else stale.push(l.file);
  }
  for (const f of stale) {
    try {
      fs.unlinkSync(f); // 崩溃残留自动回收
    } catch {
      /* ignore */
    }
  }
  if (stale.length) say(`回收 ${stale.length} 份陈旧租借（pid 已死）`);

  if (preferred) {
    if (occupied.has(preferred)) throw new Error(`端口 ${preferred} 已被另一路 runner 占用（--port 不自动跳，避免调试时端口漂移）`);
    if (await portBusy(preferred)) throw new Error(`端口 ${preferred} 已被其他进程监听`);
    return preferred;
  }
  for (let p = FIRST_PORT; p <= LAST_PORT; p++) {
    if (occupied.has(p)) continue;
    if (await portBusy(p)) continue;
    return p;
  }
  throw new Error(`端口 ${FIRST_PORT}~${LAST_PORT} 全部被占，拒绝再起站点`);
}

// ───────────────────────────── 站点 ─────────────────────────────

/** `GET /` 的状态码；连不上/超时一律 0。就绪判据用真 HTTP，不用裸 TCP：能连上但回 500 的站
 *  （比如环境回落 Production、StaticWebAssets 全 404）不该被当成"就绪"。 */
const httpStatus = url =>
  new Promise(resolve => {
    const u = new URL(url);
    const req = http.get({ host: u.hostname, port: u.port, path: '/', timeout: 1500 }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });

/** 预检：`--no-build` 要求构建产物已在。缺失时给一句可操作的提示，别让它掉进 2s 循环里。 */
function preflight(config) {
  const dll = path.join(PROJECT, 'bin', config, 'net8.0', 'jtjsym.dll');
  if (fs.existsSync(dll)) return dll;
  console.error(`[site-runner] 缺构建产物：${dll}`);
  console.error(`[site-runner] 先跑 \`dotnet build jtjsym/jtjsym\`（默认 Debug），`);
  console.error(`[site-runner] 或用 --configuration Release 并确保已 \`dotnet build -c Release\`。`);
  process.exit(1);
}

function tail(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return lines.slice(-n).join('\n');
  } catch {
    return '（日志不可读）';
  }
}

/** Windows 上 `child.kill()` 只杀 dotnet、留下应用进程变孤儿继续占端口 ⇒ 整棵树杀。 */
function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* 已死 */
      }
    }
  }
}

// ───────────────────────────── 三种模式 ─────────────────────────────

/** --print-base：**纯读，不 spawn**。轮询 base.txt + 探活，最多等 60s。 */
async function printBase() {
  const t0 = Date.now();
  for (;;) {
    let url = null;
    try {
      url = fs.readFileSync(BASE_TXT, 'utf8').trim();
    } catch {
      /* 还没写 */
    }
    if (url && (await httpStatus(url)) === 200) {
      process.stdout.write(url + '\n');
      return 0;
    }
    if (Date.now() - t0 > PRINT_BASE_TIMEOUT_MS) {
      say(`等 ${PRINT_BASE_TIMEOUT_MS / 1000}s 仍拿不到就绪的 BASE_URL（${BASE_TXT}）——先起 \`node tools/e2e/site-runner.mjs\``);
      return 2;
    }
    await sleep(500);
  }
}

/** --stop：只杀本机 runner 记录过的 pid，另一路的站不受影响。 */
async function stopAll() {
  const leases = readLeases();
  if (!leases.length) {
    say('没有租借记录，无事可做');
    process.exit(0);
  }
  for (const l of leases) {
    if (pidAlive(l.pid)) {
      say(`停止端口 ${l.port}（pid ${l.pid}）`);
      killTree(l.pid);
      await sleep(500); // 等它真退干净，否则下一轮会撞上没释放的端口
    } else {
      say(`端口 ${l.port} 的 pid ${l.pid} 已不在，仅清理租借`);
    }
    dropLease(l.port);
  }
  try {
    fs.unlinkSync(BASE_TXT);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

/** 前台看护。 */
async function run() {
  const config = argOf('--configuration', 'Debug');
  preflight(config);
  const port = await pickPort(argOf('--port') ? Number(argOf('--port')) : null);
  const baseUrl = `http://localhost:${port}`;
  const logTarget = process.env.JTJSYM_SITE_LOG ?? LOG;

  let child = null;
  let startedAt = 0;
  let fastDeaths = 0;
  let stopping = false;

  const launch = () => {
    // append（不是 `>`）：TRIS-23 只判 `after.subarray(baseBytes)` 的增量，
    // 截断会把它的字节基线清空 ⇒ 历史异常被算进本轮。哨兵 `Now listening on` 一次成功即永久满足。
    const out = fs.openSync(logTarget, 'a');
    const args = [
      'run', '--project', PROJECT, '--no-build', '--no-launch-profile',
      '--environment', 'Development', '--urls', baseUrl,
    ];
    if (config !== 'Debug') args.push('--configuration', config);
    startedAt = Date.now();
    child = spawn('dotnet', args, {
      cwd: E2E_DIR,                       // 日志落点与 webServer 的 `>` 目标同一文件
      stdio: ['ignore', out, out],
      // D-43：`spawn` 的 env 是**替换**语义（不是 Playwright `webServer.env` 那种合并）——
      // 只传 `{ Lianliankan__DataDir }` 会把 PATH / DOTNET_* / ASPNETCORE_* 全抹掉，站点直接起不来。
      // 所以显式 `{ ...process.env, … }`；且**不复用** process.env 里可能已有的同名值，
      // 否则「外面碰巧 export 过」会掩盖这条注入到底有没有生效。
      env: { ...process.env, Lianliankan__DataDir: LLK_DATA_DIR },
      detached: !IS_WIN,                  // POSIX 下建进程组，才有 -pid 可杀
      windowsHide: true,
    });
    say(`启动站点 pid=${child.pid} → ${baseUrl}（日志 ${logTarget}）`);

    child.on('exit', code => {
      if (stopping) return;
      const aliveMs = Date.now() - startedAt;
      fastDeaths = aliveMs < FAST_DEATH_MS ? fastDeaths + 1 : 0;
      if (fastDeaths >= FAST_DEATH_LIMIT) {
        say(`连续 ${FAST_DEATH_LIMIT} 次启动后立即退出（末次 exit=${code}）——这是确定性失败，停止重启。`);
        say(`最后 40 行日志：\n${tail(logTarget, 40)}`);
        dropLease(port);
        process.exit(1);
      }
      say(`站点退出（code=${code}，存活 ${aliveMs}ms），${RESTART_DELAY_MS}ms 后重启`);
      setTimeout(() => { if (!stopping) launch(); }, RESTART_DELAY_MS);
    });
  };

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    say('收到退出信号，停止站点…');
    if (child?.pid) killTree(child.pid);
    setTimeout(() => {
      dropLease(port);
      process.exit(0);
    }, 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  writeLease(port, process.pid);
  launch();

  // 就绪：能连上 200 才写 base.txt。写之前先清掉旧的（端口可能变了）。
  const t0 = Date.now();
  for (;;) {
    if (await httpStatus(baseUrl) === 200) break;
    if (Date.now() - t0 > READY_TIMEOUT_MS) {
      say(`站点 ${READY_TIMEOUT_MS / 1000}s 内未就绪，最后 40 行日志：\n${tail(logTarget, 40)}`);
      killTree(child?.pid);
      dropLease(port);
      process.exit(1);
    }
    await sleep(400);
  }
  fs.mkdirSync(LEASE_DIR, { recursive: true });
  fs.writeFileSync(BASE_TXT, baseUrl + '\n', 'utf8');
  process.stdout.write(`BASE_URL=${baseUrl}\n`);          // 只有这一行走 stdout
  say('就绪。跑批用：BASE_URL=$(node tools/e2e/site-runner.mjs --print-base) PW_SITE_MANAGED=1 npx playwright test …');
  say('收工用：node tools/e2e/site-runner.mjs --stop');

  // 之后的一切都交给 child.on('exit') 的重启/判死逻辑；本函数到此不再需要做事。
  process.on('uncaughtException', e => say('uncaught:', e?.message ?? e));
}

if (hasFlag('--help') || hasFlag('-h')) {
  process.stdout.write([
    'node tools/e2e/site-runner.mjs                 前台看护（默认 14074 起，被占则往上借）',
    'node tools/e2e/site-runner.mjs --port 14080     指定首选端口（被占即报错，不自动跳）',
    'node tools/e2e/site-runner.mjs --configuration Release   用 Release 构建产物',
    'node tools/e2e/site-runner.mjs --print-base     纯读：打印已就绪的 BASE_URL（不 spawn，最多等 60s）',
    'node tools/e2e/site-runner.mjs --stop           只杀本机 runner 记录过的 pid 并清租借',
    '',
  ].join('\n'));
  process.exit(0);
}
if (hasFlag('--print-base')) process.exit(await printBase());
if (hasFlag('--stop')) await stopAll();
await run();
