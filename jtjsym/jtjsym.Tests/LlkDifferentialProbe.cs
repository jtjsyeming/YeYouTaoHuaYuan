using jtjsym.Services;
using Xunit;

namespace jtjsym.Tests;

/// <summary>
/// CanConnect 差分回归闸（D-30 排查产物，永久保留）：
/// BFS 版 <see cref="LianliankanCore.CanConnect"/> vs 朴素递归全路径枚举（扩一圈全空网格）。
/// <para>用户报"点两个一样的不会消除"后做的排除法实证：<b>既有的 38 条</b>连连看单测 + 12 条 e2e + 本条差分
/// 全绿 ⇒ 算法无误判，故障在展示层反馈缺失（详见《38》§2）。本闸钉住的是一件具体的事：
/// <b>BFS 与朴素全路径枚举在任意密度/几何下逐对等价</b>（300 盘、&gt;5000 对）。</para>
/// <para>⚠ 它<b>证明不了</b>"外圈可以绕行"这条语义 —— 随机盘不保证出现"整行占满、只能绕盘外"
/// 那种极端几何。外绕由 <c>LianliankanCoreTests.CanConnect_TwoTurns_OuterRing_True</c> 正面专管。
/// （当初把这里当成外绕看守是误判：第一个差分版本的参照写错了"外圈只能站住不能走"，
/// 于是误报 BFS 偏宽松 —— 真正的教训是<b>参照自己会写错</b>，这句话写在这儿比多加一条 [Fact] 有用。）</para>
/// </summary>
public class LlkDifferentialProbe
{
    /// <summary>
    /// 朴素参照：把棋盘<b>扩一圈全空</b>（外圈绕行合法），从源点沿 dir 直走、
    /// 途中每个空格可继续直走或拐弯（≤2 拐），走进 target 即连通。
    /// </summary>
    private static bool Reference(int[] cells, int rows, int cols, int r1, int c1, int r2, int c2)
    {
        var R = rows + 2;
        var C = cols + 2;
        var g = new int[R * C];
        for (var r = 0; r < rows; r++)
        {
            for (var c = 0; c < cols; c++)
            {
                g[(r + 1) * C + (c + 1)] = cells[r * cols + c];
            }
        }

        var sr = r1 + 1;
        var sc = c1 + 1;
        var tr = r2 + 1;
        var tc = c2 + 1;
        var dirs = new[] { (-1, 0), (1, 0), (0, -1), (0, 1) };

        bool Walk(int r, int c, int dr, int dc, int turnsLeft)
        {
            var nr = r + dr;
            var nc = c + dc;
            while (true)
            {
                if (nr < 0 || nr >= R || nc < 0 || nc >= C) return false;
                if (nr == tr && nc == tc) return true;
                if (g[nr * C + nc] != 0) return false;

                if (turnsLeft > 0)
                {
                    foreach (var (ndr, ndc) in dirs)
                    {
                        if (ndr == -dr && ndc == -dc) continue;
                        if (Walk(nr, nc, ndr, ndc, turnsLeft - 1)) return true;
                    }
                }
                nr += dr;
                nc += dc;
            }
        }

        foreach (var (dr, dc) in dirs)
        {
            if (Walk(sr, sc, dr, dc, 2)) return true;
        }
        return false;
    }

    [Fact]
    public void CanConnect_MatchesReference_OnRandomBoards()
    {
        // 这里用 System.Random 是<b>故意的</b>，与产品代码"禁用 System.Random、改自实现 SplitMix64"
        // 的规则不冲突：那条规则要的是**盘面可复现**（今天是哪一关对全世界都一样），
        // 而测试数据不构成产品契约 —— 本断言只看 got == want，换个 .NET 版本重排一遍照样成立。
        var rng = new Random(20261113);
        long checkedPairs = 0;
        for (var iter = 0; iter < 300; iter++)
        {
            // 随机密度盘：48 格填 24 对（与真实盘同构），密度从稀疏到全满
            var fill = 0.3 + 0.7 * rng.NextDouble();
            var cells = new int[48];
            var slots = Enumerable.Range(0, 48).Where(_ => rng.NextDouble() < fill).ToList();
            if (slots.Count < 2) continue;
            var values = new int[slots.Count];
            for (var i = 0; i < values.Length; i += 2)
            {
                var f = rng.Next(1, 25);
                values[i] = f;
                if (i + 1 < values.Length) values[i + 1] = f;
            }
            // 奇数个槽位时最后一个值落单 → 改 0
            if (values.Length % 2 == 1) values[^1] = 0;
            for (var i = values.Length - 1; i > 0; i--)
            {
                var j = rng.Next(i + 1);
                (values[i], values[j]) = (values[j], values[i]);
            }
            for (var i = 0; i < slots.Count; i++) cells[slots[i]] = values[i];

            var core = RestoreCore(cells);
            for (var a = 0; a < 48; a++)
            {
                if (cells[a] == 0) continue;
                for (var b = a + 1; b < 48; b++)
                {
                    if (cells[b] != cells[a]) continue;
                    var got = core.CanConnect(a / 6, a % 6, b / 6, b % 6);
                    var want = Reference(cells, 8, 6, a / 6, a % 6, b / 6, b % 6);
                    checkedPairs++;
                    Assert.True(got == want,
                        $"iter={iter} 盘={string.Join(',', cells)} 格 {a}({a / 6},{a % 6})↔{b}({b / 6},{b % 6}) face={cells[a]}：BFS={got} 参照={want}");
                }
            }
        }
        Assert.True(checkedPairs > 5000, $"对拍样本过少：{checkedPairs}");
    }

    private static LianliankanCore RestoreCore(int[] cells)
    {
        var snap = new LianliankanSnapshot { V = 1, Issue = 20261113, Cells = cells, ElapsedSec = 1 };
        var core = LianliankanCore.TryFrom(snap, 20261113);
        Assert.NotNull(core);
        return core!;
    }
}
