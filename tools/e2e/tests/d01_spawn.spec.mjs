// D-01：新块生成概率标准化（90% 出 2 / 10% 出 4）
// 手法：连续重开 N 局，只统计"初始两块"的取值——每局 2 个独立样本，不掺杂走棋逻辑。
import { test } from '@playwright/test';
import { check, open, readBoard, sleep } from './helpers.mjs';

const ROUNDS = 50;      // 50 局 → 100 个样本（实测 12.7s）
const MAX_FOUR = 25;    // 90/10 下期望 10（σ=3），25 已 +5σ

test.describe('D01 新块生成概率', () => {
  test('G2048-23 初始块取值分布：90% 出 2 / 10% 出 4', async ({ page }) => {
    test.slow();                                   // 实测 ~13s，60s 默认超时偏紧
    await open(page, '/game_2048', 1600);

    let c2 = 0, c4 = 0, bad = 0, samples = 0;
    for (let i = 0; i < ROUNDS; i++) {
      await page.locator('.replay-btn').first().click();
      await sleep(250);                            // 实测"点击→重渲染→读盘"往返 247ms
      const vals = (await readBoard(page)).flat().filter(v => v !== 0);
      if (vals.length !== 2) bad++;
      for (const v of vals) {
        samples++;
        if (v === 2) c2++;
        else if (v === 4) c4++;
        else bad++;
      }
    }

    const rate = samples ? ((c4 / samples) * 100).toFixed(1) : '0';
    check('G2048-23-取值域', bad === 0, `异常局/块 ${bad}（要求每局恰 2 块且值 ∈ {2,4}）`);
    check('G2048-23-上界', c4 <= MAX_FOUR, `4 出现 ${c4}/${samples}（${rate}%）；90/10 期望 10，上界 ${MAX_FOUR}`);
    check('G2048-23-下界', c4 >= 1, `4 出现 ${c4} 次（n=${samples} 下 0 次的概率 ≈2.7e-5）`);
  });
});
