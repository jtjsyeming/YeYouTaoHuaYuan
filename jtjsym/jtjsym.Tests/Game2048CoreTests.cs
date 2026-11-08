using jtjsym.Services;
using Xunit;

namespace jtjsym.Tests;

/// <summary>
/// 2048 纯逻辑单测（《26》阶段④ / H-008）。用例来源：
/// <list type="bullet">
///   <item>《05》§4.3 的 9 组方向-左验证表（含空行）；</item>
///   <item>《07》§6.2 的 G2048-07~18（12 条，与上表大量重叠，按下表"并集去重"落）；</item>
///   <item>死局/可动判定 4 条（对应 G2048-19/20 的判定侧，e2e 侧见 G2048-39/43）；</item>
///   <item>SpawnValue 比例区间 1 条（D-01）。</item>
/// </list>
/// <para>判据只认"输入 → 输出 + 计分"，不碰任何组件状态：这正是抽离的目的（原来锁在 razor 里无法单测）。</para>
/// </summary>
public class Game2048CoreTests
{
    // ─────────────────────── Merge：方向"左"的 9 组（《05》§4.3）───────────────────────

    [Theory]
    // #1 G2048-07 两对，各自合并
    [InlineData(new[] { 2, 2, 2, 2 }, new[] { 4, 4, 0, 0 }, 8)]
    // #2 G2048-08 奇数列缺一 → 只合并前两个
    [InlineData(new[] { 2, 2, 2, 0 }, new[] { 4, 2, 0, 0 }, 4)]
    // #3 G2048-09 合并出的 4 不得与左侧原 4 再合并
    [InlineData(new[] { 4, 2, 2, 0 }, new[] { 4, 4, 0, 0 }, 4)]
    // #4 G2048-10 先压缩再合并（跨过空洞）
    [InlineData(new[] { 2, 2, 0, 2 }, new[] { 4, 2, 0, 0 }, 4)]
    // #5 G2048-12 空洞隔开的等值仍须合并
    [InlineData(new[] { 2, 0, 2, 4 }, new[] { 4, 4, 0, 0 }, 4)]
    // #6 G2048-11 无相邻等值 → 原样返回（但会左对齐）
    [InlineData(new[] { 2, 4, 2, 0 }, new[] { 2, 4, 2, 0 }, 0)]
    // #7 空行不做任何事
    [InlineData(new[] { 0, 0, 0, 0 }, new[] { 0, 0, 0, 0 }, 0)]
    // #8 G2048-14 两组 8 → 16+16
    [InlineData(new[] { 8, 8, 8, 8 }, new[] { 16, 16, 0, 0 }, 32)]
    // #9 G2048-13 两对各自合并 → 4 与 8
    [InlineData(new[] { 2, 2, 4, 4 }, new[] { 4, 8, 0, 0 }, 12)]
    // #10 G2048-16 仅左对齐、无合并
    [InlineData(new[] { 0, 0, 0, 4 }, new[] { 4, 0, 0, 0 }, 0)]
    public void Merge_Left_MatchesStandardTable(int[] input, int[] expected, int expectedGain)
    {
        int score = 0;
        var actual = Game2048Core.Merge(input, ref score);

        Assert.Equal(expected, actual);
        Assert.Equal(expectedGain, score);
        // 长度不变是组件侧的隐式契约（SetRow/SetColumn 按下标回写），独立断言一次
        Assert.Equal(input.Length, actual.Length);
    }

    [Fact]
    public void Merge_DoesNotMutateInput()
    {
        var input = new[] { 2, 2, 4, 4 };
        int score = 0;
        _ = Game2048Core.Merge(input, ref score);

        Assert.Equal(new[] { 2, 2, 4, 4 }, input);
    }

    // ───────────────────── 长度契约：异长输入必须等长返回（P-029）─────────────────────
    // 组件侧恒传 4 格，但 Merge 用 line.Length 驱动压缩与补零，故"等长返回"是可依赖的契约；
    // 这两条把它钉死（`i += 2` 保证合并出的新块不参与本轮再合并，所以不会链式反应）。

    [Fact]
    public void Merge_ThreeCellLine_ReturnsThreeCells()
    {
        int score = 0;
        var actual = Game2048Core.Merge(new[] { 2, 2, 2 }, ref score);

        Assert.Equal(new[] { 4, 2, 0 }, actual);
        Assert.Equal(4, score);
    }

    [Fact]
    public void Merge_FiveCellLine_ReturnsFiveCells()
    {
        int score = 0;
        var actual = Game2048Core.Merge(new[] { 2, 2, 2, 2, 2 }, ref score);

        Assert.Equal(new[] { 4, 4, 2, 0, 0 }, actual);
        Assert.Equal(8, score);
    }

    // ──────────── Merge：右/下方向 = Reverse 后复用（G2048-15/17/18 的算法侧）────────────
    // 组件里右/下就是 `Merge(line.Reverse()).Reverse()`，抽离后这段组合仍在 razor 里，
    // 故这里用同一种组合验证"方向语义"确实由 Reverse 复用保证，而不是另写了一份。

    private static int[] MergeTowardRight(int[] line, ref int score)
        => Game2048Core.Merge(line.Reverse().ToArray(), ref score).Reverse().ToArray();

    [Theory]
    // G2048-17 行 [4,0,0,0] 按右 → 仅右对齐
    [InlineData(new[] { 4, 0, 0, 0 }, new[] { 0, 0, 0, 4 }, 0)]
    // G2048-18 行 [2,2,0,0] 按右 → 右对齐后合并
    [InlineData(new[] { 2, 2, 0, 0 }, new[] { 0, 0, 0, 4 }, 4)]
    public void MergeTowardRight_MatchesStandardTable(int[] input, int[] expected, int expectedGain)
    {
        int score = 0;
        var actual = MergeTowardRight(input, ref score);

        Assert.Equal(expected, actual);
        Assert.Equal(expectedGain, score);
    }

    // ─────────────────────── 死局 / 可动判定（G2048-19/20 的判定侧）───────────────────────

    /// <summary>满盘且无相邻同值 —— 与 e2e 的 G2048-39 同一盘面</summary>
    private static readonly int[] DeadFull =
    {
        2, 4, 2, 4,
        4, 2, 4, 2,
        2, 4, 2, 4,
        4, 2, 4, 2,
    };

    /// <summary>满盘但首行左端有一对 2 —— 与 e2e 的 G2048-43 同一盘面</summary>
    private static readonly int[] FullWithOnePair =
    {
        2, 2, 4, 8,
        4, 8, 16, 32,
        8, 16, 32, 64,
        16, 32, 64, 128,
    };

    [Fact]
    public void IsGameOver_True_WhenFullAndNoAdjacentEqual()
    {
        Assert.True(Game2048Core.IsGameOver(DeadFull));
    }

    [Fact]
    public void IsGameOver_False_WhenFullButOneAdjacentPair()
    {
        Assert.False(Game2048Core.IsGameOver(FullWithOnePair));
        // 反证：拆掉那一对后立刻变死局 —— 说明 false 确实来自"那一对"，不是别处还有活路。
        // ⚠ 不能简单改成 broken[0] = 4：那会与下一行首格的 4 竖直相邻，依旧可动，反证就失去意义。
        var broken = (int[])FullWithOnePair.Clone();
        broken[1] = 16;   // 首行 → [2,16,4,8]：横向无等值，纵向各列也无等值
        Assert.True(Game2048Core.IsGameOver(broken));
    }

    [Fact]
    public void IsGameOver_False_WhenBoardHasEmptyCell()
    {
        var cells = (int[])DeadFull.Clone();
        cells[15] = 0;
        Assert.False(Game2048Core.IsGameOver(cells));
    }

    [Fact]
    public void IsGameOver_False_WhenSingleTile()
    {
        var cells = new int[16];
        cells[5] = 2;
        Assert.False(Game2048Core.IsGameOver(cells));
    }

    [Theory]
    [InlineData(15)]   // 长度不足
    [InlineData(17)]   // 长度超出
    public void IsGameOver_Throws_OnWrongLength(int length)
    {
        Assert.Throws<ArgumentException>(() => Game2048Core.IsGameOver(new int[length]));
    }

    // ────────────────── 存档内容闸：IsValidArchive（P-019，随迁 Core 才可测）──────────────────

    /// <summary>
    /// 把"前 n 块"放进 16 格盘（其余为 0）：IsValidArchive 本身不看长度，但用例保持与真实存档同形。
    /// </summary>
    private static int[] Archive(params int[] tiles)
    {
        var cells = new int[16];
        Array.Copy(tiles, cells, tiles.Length);
        return cells;
    }

    [Theory]
    // 判据 ④ 的正反两端：cap 内、且是 4 的倍数才放行
    [InlineData(new[] { 4, 4 }, 8, true)]        // G2048-41：等于上界（8 = 4·(2−1)·2）
    [InlineData(new[] { 4, 4 }, 6, false)]       // P-019 新增：cap 内但非 4 倍数 ⇒ 必须拒
    // FT-18 的伪分（连续三版 FAIL 的那一档）：33790 % 4 == 2
    [InlineData(new[] { 2048, 1024, 512 }, 33790, false)]
    // 同一盘面的精确上界：20480 + 9216 + 4096 = 33792，恰等即放行（证明拒绝来自 %4 而非上界）
    [InlineData(new[] { 2048, 1024, 512 }, 33792, true)]
    [InlineData(new[] { 2048, 1024, 512 }, 33796, false)]   // 超上界（且仍是 4 的倍数）
    // 判据 ②：全零盘（P-004）
    [InlineData(new int[0], 0, false)]
    // 判据 ①：非 2 的幂 / 超单块上界 / 低于 2
    [InlineData(new[] { 3 }, 0, false)]
    [InlineData(new[] { 262144 }, 0, false)]
    [InlineData(new[] { 1 }, 0, false)]
    // 判据 ③ 的边界：单块 2 的可证上界为 0
    [InlineData(new[] { 2 }, 0, true)]
    [InlineData(new[] { 2 }, 4, false)]
    // 负分（d18:40 的注入档）
    [InlineData(new[] { 4, 4 }, -5, false)]
    public void IsValidArchive_EnforcesAllFourCriteria(int[] tiles, int score, bool expected)
    {
        Assert.Equal(expected, Game2048Core.IsValidArchive(Archive(tiles), score));
    }

    // ─────────────────────── SpawnValue：90/10 的比例区间（D-01）───────────────────────

    /// <summary>
    /// 种子固定 + 10 万样本，断言"出 4"的比例落在 8%~12%。
    /// <para>⚠ 这不是随机性检验：种子固定时它检验的是 <c>Next(100) &lt; 90</c> 这个**映射比例**，
    /// 用"卡方检验"称呼它是不准确的（v1.0 文档的说法已改）。真正的随机性由 <see cref="Random"/> 保证，不归本类验证。</para>
    /// </summary>
    [Fact]
    public void SpawnValue_FourRatio_StaysAroundTenPercent()
    {
        const int Samples = 100_000;
        var rng = new Random(20261107);

        int fours = 0;
        for (int i = 0; i < Samples; i++)
        {
            int v = Game2048Core.SpawnValue(rng);
            Assert.True(v is 2 or 4, $"只允许生成 2 或 4，实际 {v}");
            if (v == 4) fours++;
        }

        double ratio = (double)fours / Samples;
        Assert.InRange(ratio, 0.08, 0.12);
    }

    [Fact]
    public void SpawnValue_HonoursCustomFourPercent()
    {
        var rng = new Random(42);
        for (int i = 0; i < 1_000; i++)
        {
            Assert.Equal(2, Game2048Core.SpawnValue(rng, fourPercent: 0));    // 0% → 永远是 2
            Assert.Equal(4, Game2048Core.SpawnValue(rng, fourPercent: 100));  // 100% → 永远是 4
        }
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(101)]
    public void SpawnValue_Throws_OnIllegalPercent(int percent)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => Game2048Core.SpawnValue(new Random(1), percent));
    }
}
