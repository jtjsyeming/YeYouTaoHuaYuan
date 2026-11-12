using System.Text.Json;
using jtjsym.Services;
using Xunit;

namespace jtjsym.Tests;

/// <summary>
/// 扫雷内核的单测（《34》§5.B2 / §6.1）。
/// <para>这是把扫雷逻辑抽进 <see cref="MinesweeperCore"/> 的<b>唯一理由</b>：e2e 只能看到"点了之后盘面变了"，
/// 而"首点 3×3 一定无雷""雷数恰好 10""哪一种坏档被哪一道闸拦下"这些结论必须在单测里逐条钉住。</para>
/// <para>随机数一律传固定种子 —— 布雷由调用方注入 <see cref="Random"/>，就是为了让这里可复现。</para>
/// </summary>
public class MinesweeperCoreTests
{
    private static MinesweeperCore NewBeginner(int seed = 20261111) =>
        MinesweeperCore.NewGame(MinesweeperLevels.Beginner, new Random(seed));

    // ─────────────────────────── 首点安全 ───────────────────────────

    /// <summary>首点必落在"首格 + 8 邻域无雷"的禁区里 —— 三档位置（角落 / 边 / 中心）各验一次。</summary>
    [Theory]
    [InlineData(0, 0)]
    [InlineData(8, 8)]
    [InlineData(0, 4)]
    [InlineData(4, 4)]
    public void FirstReveal_NeverHitsMine_AndItsNeighbourhoodIsClear(int r, int c)
    {
        var g = NewBeginner();
        Assert.True(g.Reveal(r, c));

        for (var dr = -1; dr <= 1; dr++)
        {
            for (var dc = -1; dc <= 1; dc++)
            {
                var rr = r + dr;
                var cc = c + dc;
                if (rr < 0 || rr >= g.Rows || cc < 0 || cc >= g.Cols) continue;
                Assert.False(g.IsMine(rr, cc), $"首点 ({r},{c}) 的邻域 ({rr},{cc}) 出现了雷");
            }
        }

        Assert.True(g.MinesPlaced);
        Assert.Equal(0, g.Adjacent(r, c));   // 邻域无雷 ⇒ 首格相邻雷数恒为 0 ⇒ 必然洪泛
    }

    /// <summary>首格相邻雷数恒为 0 ⇒ 首点必然触发洪泛，"翻开数 &gt; 1"是硬结论（不是概率）。</summary>
    [Fact]
    public void FirstReveal_AlwaysFloods()
    {
        for (var seed = 1; seed <= 20; seed++)
        {
            var g = MinesweeperCore.NewGame(MinesweeperLevels.Beginner, new Random(seed));
            g.Reveal(4, 4);
            Assert.True(g.RevealedSafeCount > 1, $"seed={seed} 首点后只翻开 {g.RevealedSafeCount} 格");
        }
    }

    // ─────────────────────────── 雷数 ───────────────────────────

    [Theory]
    [InlineData("beginner", 10)]
    [InlineData("intermediate", 40)]
    public void MineCount_IsExact(string key, int expected)
    {
        var level = MinesweeperLevels.ByKey(key)!;
        var g = MinesweeperCore.NewGame(level, new Random(7));
        g.Reveal(0, 0);

        var mines = 0;
        foreach (var v in g.ToFlatCells()) if (v == -2) mines++;
        Assert.Equal(expected, mines);
        Assert.Equal(expected, g.MineCount);
    }

    /// <summary>洪泛不变式：所有相邻雷数为 0 的已翻格，其 8 邻域必须全部已翻（否则就是漏扩散）。</summary>
    [Fact]
    public void Flood_LeavesNoZeroCellUnclosed()
    {
        var g = NewBeginner();
        g.Reveal(4, 4);

        for (var r = 0; r < g.Rows; r++)
        {
            for (var c = 0; c < g.Cols; c++)
            {
                if (!g.IsRevealed(r, c) || g.Adjacent(r, c) != 0) continue;
                for (var dr = -1; dr <= 1; dr++)
                {
                    for (var dc = -1; dc <= 1; dc++)
                    {
                        var rr = r + dr;
                        var cc = c + dc;
                        if (rr < 0 || rr >= g.Rows || cc < 0 || cc >= g.Cols) continue;
                        Assert.True(g.IsRevealed(rr, cc), $"零格 ({r},{c}) 的邻格 ({rr},{cc}) 没被展开");
                    }
                }
            }
        }
    }

    /// <summary>展开区的边界必须是数字格：存在"已翻且相邻雷数 &gt; 0"的格子，且它的某个邻格未翻。</summary>
    [Fact]
    public void Flood_BoundaryCellsAreNumbers()
    {
        var g = NewBeginner();
        g.Reveal(4, 4);

        var boundary = 0;
        for (var r = 0; r < g.Rows; r++)
        {
            for (var c = 0; c < g.Cols; c++)
            {
                if (!g.IsRevealed(r, c) || g.Adjacent(r, c) == 0) continue;
                for (var dr = -1; dr <= 1; dr++)
                {
                    for (var dc = -1; dc <= 1; dc++)
                    {
                        var rr = r + dr;
                        var cc = c + dc;
                        if (rr < 0 || rr >= g.Rows || cc < 0 || cc >= g.Cols) continue;
                        if (!g.IsRevealed(rr, cc)) boundary++;
                    }
                }
            }
        }
        Assert.True(boundary > 0, "洪泛区域没有任何数字边界格 —— 展开逻辑可疑");
    }

    // ─────────────────────────── 插旗 ───────────────────────────

    [Fact]
    public void Flag_Toggles_BlocksReveal_AndCountsDown()
    {
        var g = NewBeginner();
        g.Reveal(4, 4);

        var (r, c) = FirstUnrevealed(g);
        Assert.Equal(10, g.RemainingMines);

        Assert.True(g.ToggleFlag(r, c));
        Assert.True(g.IsFlagged(r, c));
        Assert.Equal(9, g.RemainingMines);
        Assert.False(g.Reveal(r, c), "插旗格不该被翻开");
        Assert.False(g.IsRevealed(r, c));

        Assert.True(g.ToggleFlag(r, c));
        Assert.False(g.IsFlagged(r, c));
        Assert.Equal(10, g.RemainingMines);
    }

    /// <summary>不能给已翻格插旗（否则快照里会出现"已翻 + 有旗"的半截态）。</summary>
    [Fact]
    public void Flag_RejectsRevealedCell()
    {
        var g = NewBeginner();
        g.Reveal(4, 4);
        Assert.False(g.ToggleFlag(4, 4));
        Assert.False(g.IsFlagged(4, 4));
    }

    /// <summary>剩余雷数可为负、显示原值（《34》§4.2）。</summary>
    [Fact]
    public void RemainingMines_CanGoNegative()
    {
        var g = NewBeginner();
        g.Reveal(4, 4);

        var flagged = 0;
        for (var r = 0; r < g.Rows && flagged < 13; r++)
        {
            for (var c = 0; c < g.Cols && flagged < 13; c++)
            {
                if (g.IsRevealed(r, c)) continue;
                if (g.ToggleFlag(r, c)) flagged++;
            }
        }

        Assert.Equal(13, g.FlagCount);
        Assert.Equal(-3, g.RemainingMines);
    }

    // ─────────────────────────── 胜负 ───────────────────────────

    [Fact]
    public void RevealMine_Loses_AndLocksBoard()
    {
        var g = NewBeginner();
        g.Reveal(4, 4);

        var (r, c) = FirstMine(g);
        Assert.True(g.Reveal(r, c));
        Assert.True(g.IsLose);
        Assert.True(g.IsOver);

        // 结束态一律拒绝后续操作
        var (ur, uc) = FirstUnrevealed(g);
        Assert.False(g.Reveal(ur, uc));
        Assert.False(g.ToggleFlag(ur, uc));
    }

    /// <summary>胜局：仅剩 1 格安全格未翻的档，点开即胜。</summary>
    [Fact]
    public void LastSafeCell_Wins()
    {
        var mines = new[] { 0, 1, 2, 3, 9, 18, 27, 36, 45, 54 };   // 10 雷，避开第 0 行之外的随机性
        var lastSafe = 80;                                          // 右下角，不是雷
        var snap = BuildBeginnerSnapshot(mines, leaveUnrevealed: lastSafe);

        var g = MinesweeperCore.TryFrom(snap);
        Assert.NotNull(g);
        Assert.False(g!.IsWin);

        Assert.True(g.Reveal(lastSafe / g.Cols, lastSafe % g.Cols));
        Assert.True(g.IsWin);
        Assert.True(g.IsOver);
        Assert.False(g.Reveal(1, 1));
    }

    // ─────────────────────────── 快照 ───────────────────────────

    [Fact]
    public void Snapshot_RoundTrips()
    {
        var g = NewBeginner();
        g.Reveal(4, 4);
        var (fr, fc) = FirstUnrevealed(g);
        g.ToggleFlag(fr, fc);

        var snap = g.ToSnapshot(37);
        var back = MinesweeperCore.TryFrom(snap);

        Assert.NotNull(back);
        Assert.Equal(g.Level.Key, back!.Level.Key);
        Assert.Equal(g.MinesPlaced, back.MinesPlaced);
        Assert.Equal(g.FlagCount, back.FlagCount);
        Assert.Equal(g.RevealedSafeCount, back.RevealedSafeCount);
        Assert.Equal(g.RemainingMines, back.RemainingMines);
        Assert.Equal(g.ToFlatCells(), back.ToFlatCells());
        Assert.Equal(g.ToFlatFlags(), back.ToFlatFlags());
    }

    /// <summary>短键名契约：这些名字一旦改了，浏览器里的旧档就会静默读不出来（只增不改版本号也不行）。</summary>
    [Fact]
    public void Snapshot_UsesShortJsonKeys()
    {
        var json = JsonSerializer.Serialize(NewBeginner().ToSnapshot(0));
        foreach (var key in new[] { "\"v\"", "\"rows\"", "\"cols\"", "\"mineCount\"", "\"difficulty\"", "\"elapsedSec\"", "\"minesPlaced\"", "\"cells\"", "\"flags\"" })
        {
            Assert.Contains(key, json);
        }
        Assert.NotNull(JsonSerializer.Deserialize<MinesweeperSnapshot>(json));
    }

    // ─────────────────────────── 坏档拒收（每道闸一条）───────────────────────────

    private static MinesweeperSnapshot ValidSnapshot()
    {
        var g = NewBeginner();
        g.Reveal(4, 4);
        return g.ToSnapshot(12);
    }

    [Fact]
    public void Rejects_NullAndWrongVersion()
    {
        Assert.Null(MinesweeperCore.TryFrom(null));

        var s = ValidSnapshot();
        s.V = 2;
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    [Fact]
    public void Rejects_UnknownDifficulty()
    {
        var s = ValidSnapshot();
        s.Difficulty = "expert";
        Assert.Null(MinesweeperCore.TryFrom(s));

        s = ValidSnapshot();
        s.Difficulty = null;
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    /// <summary>尺寸/雷数必须与档位自洽 —— 只校验"长度 = rows×cols"挡不住伪造的 5×5/999 雷。</summary>
    [Fact]
    public void Rejects_DimensionOrMineCountMismatch()
    {
        var s = ValidSnapshot();
        s.Rows = 16;
        Assert.Null(MinesweeperCore.TryFrom(s));

        s = ValidSnapshot();
        s.MineCount = 11;
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    [Fact]
    public void Rejects_ArrayLengthMismatch()
    {
        var s = ValidSnapshot();
        s.Cells = s.Cells![..80];
        Assert.Null(MinesweeperCore.TryFrom(s));

        s = ValidSnapshot();
        s.Flags = s.Flags![..80];
        Assert.Null(MinesweeperCore.TryFrom(s));

        s = ValidSnapshot();
        s.Cells = null;
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    [Fact]
    public void Rejects_ElapsedOutOfRange()
    {
        var s = ValidSnapshot();
        s.ElapsedSec = -1;
        Assert.Null(MinesweeperCore.TryFrom(s));

        s = ValidSnapshot();
        s.ElapsedSec = MinesweeperCore.MaxElapsedSec + 1;
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    /// <summary>9 = 已翻的雷。败局的第一件事就是清档，所以它出现在档里必然是被改过的。</summary>
    [Fact]
    public void Rejects_RevealedMineAndOutOfRangeValues()
    {
        var s = ValidSnapshot();
        s.Cells![0] = 9;
        Assert.Null(MinesweeperCore.TryFrom(s));

        s = ValidSnapshot();
        s.Cells![0] = -3;
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    [Fact]
    public void Rejects_FlagOnRevealedCell()
    {
        var s = ValidSnapshot();
        var idx = Array.IndexOf(s.Cells!, 0);      // 首点洪泛后必存在已翻的 0 格
        Assert.True(idx >= 0);
        s.Flags![idx] = true;
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    [Fact]
    public void Rejects_RevealedCellWhenMinesNotPlaced()
    {
        var s = ValidSnapshot();
        s.MinesPlaced = false;         // 未布雷却有已翻格 → 半截写入
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    [Fact]
    public void Rejects_MineCountDisagreesWithBoard()
    {
        var s = ValidSnapshot();
        var idx = Array.IndexOf(s.Cells!, -2);
        Assert.True(idx >= 0);
        s.Cells![idx] = -1;            // 拔掉一颗雷
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    /// <summary>数字一致性：已翻格的数字必须等于邻域实际雷数。</summary>
    [Fact]
    public void Rejects_AdjacentCountMismatch()
    {
        var s = ValidSnapshot();
        var idx = Array.IndexOf(s.Cells!, 0);
        Assert.True(idx >= 0, "首点洪泛后应存在 0 格");
        s.Cells![idx] = 3;
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    /// <summary>胜局不写档 ⇒ 已经翻开全部安全格的档必被拒（否则返回后会立刻弹一次胜利遮罩）。</summary>
    [Fact]
    public void Rejects_AlreadyWonSnapshot()
    {
        var mines = new[] { 0, 1, 2, 3, 9, 18, 27, 36, 45, 54 };
        var s = BuildBeginnerSnapshot(mines, leaveUnrevealed: -1);
        Assert.Null(MinesweeperCore.TryFrom(s));
    }

    // ─────────────────────────── 恢复局的行为（D-26 / C-59） ───────────────────────────

    /// <summary>
    /// D-26 的最小复现：恢复局点一个**数字格**只该翻它自己。
    /// <para>根因是落库时把未翻格的邻值写成 0，而 <c>FloodReveal</c> 靠"邻值 != 0"停止扩散 ——
    /// 于是恢复局里每个未翻格都像零格，点任何安全格都会展开整片连通区（连到 71 格即伪胜局）。
    /// 修复前本用例的 <c>RevealedSafeCount</c> 会从 2 直接跳到 71。</para>
    /// <para>⚠ 目标格必须从**原始盘**里挑（恢复盘的未翻格邻值恒 0，扫不出来）：原始盘的邻值由 <c>PlaceMines</c> 算好。</para>
    /// </summary>
    [Fact]
    public void RestoredReveal_OnDigitCell_OnlyRevealsItself()
    {
        var origin = NewBeginner();
        Assert.True(origin.Reveal(4, 4));
        Assert.False(origin.IsWin, "首点不该直接通关（通关档会被 ⑧ 拒绝）");

        // 在原始盘里找一格"未翻 + 邻雷数 > 0"的数字格（恢复盘的未翻格邻值恒 0，扫不出来）
        var target = (r: -1, c: -1);
        for (var r = 0; r < origin.Rows && target.r < 0; r++)
        {
            for (var c = 0; c < origin.Cols; c++)
            {
                if (!origin.IsRevealed(r, c) && !origin.IsMine(r, c) && origin.Adjacent(r, c) > 0)
                {
                    target = (r, c);
                    break;
                }
            }
        }
        Assert.True(target.r >= 0, "首点洪泛后应仍存在未翻的数字格");

        var restored = MinesweeperCore.TryFrom(origin.ToSnapshot(5));
        Assert.NotNull(restored);

        var before = restored!.RevealedSafeCount;
        Assert.True(restored.Reveal(target.r, target.c));
        Assert.Equal(before + 1, restored.RevealedSafeCount);
    }

    /// <summary>
    /// D-26 的边界版：恢复局的洪泛必须停在正确的位置。
    /// <para>固定雷位 <c>{0..7,20,29}</c>、只翻 40 号。点 50（零格）后应停在 <b>69</b> 格，
    /// 未翻的安全格恰好是 <b>{8, 11}</b> 两个数字格 —— 逐个点开才胜。</para>
    /// <para>数字来自《35》§4.4 的独立控制台实测；修复前点 50 就会到 71 并判胜（伪胜局）。</para>
    /// </summary>
    [Fact]
    public void Restored_FloodStaysBounded()
    {
        var mines = new[] { 0, 1, 2, 3, 4, 5, 6, 7, 20, 29 };
        var s = BuildBeginnerSnapshot(mines, leaveUnrevealed: -1, revealOnly: new[] { 40 });

        var g = MinesweeperCore.TryFrom(s);
        Assert.NotNull(g);
        Assert.Equal(1, g!.RevealedSafeCount);

        Assert.True(g.Reveal(5, 5));                        // 50 号：邻雷 0 ⇒ 触发洪泛
        Assert.Equal(69, g.RevealedSafeCount);
        Assert.False(g.IsRevealed(0, 8));                   // 8 号：数字格 1
        Assert.False(g.IsRevealed(1, 2));                   // 11 号：数字格 4
        Assert.False(g.IsWin);

        Assert.True(g.Reveal(0, 8));
        Assert.Equal(70, g.RevealedSafeCount);
        Assert.False(g.IsWin, "还剩 11 号未翻，不该判胜");

        Assert.True(g.Reveal(1, 2));
        Assert.Equal(71, g.RevealedSafeCount);
        Assert.True(g.IsWin);
    }

    // ─────────────────────────── 最快时间口径（D-27 / C-59） ───────────────────────────

    /// <summary>
    /// 解析侧：坏值与 0 一律当"没有纪录"。方向与 2048/Tetris 相反（越小越好），
    /// 0 之所以无效是因为胜局处把 0 钳成了 1（方案 A，《35》§2.2）。
    /// </summary>
    [Theory]
    [InlineData("0", null)]
    [InlineData("abc", null)]
    [InlineData("-5", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    [InlineData("12", 12)]
    public void TryParseBest_RejectsNonPositive(string? raw, int? expected) =>
        Assert.Equal(expected, MinesweeperCore.TryParseBest(raw));

    /// <summary>刷新侧：只接受更小的合法值，相等不刷新（同一份档重放不该再报「新纪录！」）。</summary>
    [Theory]
    [InlineData(null, 1, 1)]        // 首条纪录
    [InlineData(10, 9, 9)]          // 更小 ⇒ 刷新
    [InlineData(10, 11, null)]      // 更大 ⇒ 不刷新
    [InlineData(10, 10, null)]      // 相等 ⇒ 不刷新
    [InlineData(null, 0, null)]     // 0 秒非法
    public void TryUpdateBest_KeepsTheSmallest(int? current, int sec, int? expected) =>
        Assert.Equal(expected, MinesweeperCore.TryUpdateBest(current, sec));

    // ─────────────────────────── 构造用具 ───────────────────────────

    private static (int, int) FirstUnrevealed(MinesweeperCore g)
    {
        for (var r = 0; r < g.Rows; r++)
            for (var c = 0; c < g.Cols; c++)
                if (!g.IsRevealed(r, c)) return (r, c);
        throw new InvalidOperationException("盘面已无未翻格");
    }

    private static (int, int) FirstMine(MinesweeperCore g)
    {
        for (var r = 0; r < g.Rows; r++)
            for (var c = 0; c < g.Cols; c++)
                if (g.IsMine(r, c)) return (r, c);
        throw new InvalidOperationException("盘面无雷");
    }

    /// <summary>
    /// 手工构造一份 9×9 初级档：雷位给定，安全格按两种口径决定"已翻 / 未翻"。
    /// <para><paramref name="revealOnly"/> 为 null 时用 <paramref name="leaveUnrevealed"/>：指定的那一格留成未翻
    /// （&gt;= 0 时），-1 表示全部翻开（= 胜局档）。</para>
    /// <para><paramref name="revealOnly"/> 非 null 时**只翻这些格**，忽略 <paramref name="leaveUnrevealed"/> ——
    /// D-26 的"只翻 40 号"档这么写不出来，否则洪泛用例无从构造。</para>
    /// </summary>
    private static MinesweeperSnapshot BuildBeginnerSnapshot(int[] mineIndexes, int leaveUnrevealed, int[]? revealOnly = null)
    {
        const int rows = 9, cols = 9;
        var isMine = new bool[rows * cols];
        foreach (var i in mineIndexes) isMine[i] = true;

        var cells = new int[rows * cols];
        for (var r = 0; r < rows; r++)
        {
            for (var c = 0; c < cols; c++)
            {
                var i = r * cols + c;
                if (isMine[i])
                {
                    cells[i] = -2;
                    continue;
                }
                if (revealOnly is not null)
                {
                    if (!revealOnly.Contains(i))
                    {
                        cells[i] = -1;
                        continue;
                    }
                }
                else if (i == leaveUnrevealed)
                {
                    cells[i] = -1;
                    continue;
                }

                var n = 0;
                for (var dr = -1; dr <= 1; dr++)
                {
                    for (var dc = -1; dc <= 1; dc++)
                    {
                        if (dr == 0 && dc == 0) continue;
                        var rr = r + dr;
                        var cc = c + dc;
                        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
                        if (isMine[rr * cols + cc]) n++;
                    }
                }
                cells[i] = n;
            }
        }

        return new MinesweeperSnapshot
        {
            V = MinesweeperSnapshot.CurrentVersion,
            Rows = rows,
            Cols = cols,
            MineCount = mineIndexes.Length,
            Difficulty = MinesweeperLevels.Beginner.Key,
            ElapsedSec = 5,
            MinesPlaced = true,
            Cells = cells,
            Flags = new bool[rows * cols],
        };
    }
}
