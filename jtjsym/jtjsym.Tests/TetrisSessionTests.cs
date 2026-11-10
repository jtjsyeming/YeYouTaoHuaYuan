using System.Text.Json;
using jtjsym.Services;
using Xunit;

namespace jtjsym.Tests;

/// <summary>
/// 俄罗斯方块对局快照的单测（《33》D-24b §6.1）。
/// <para>用例来自《33》§2.3 的五道闸，逐条落成 <c>[Fact]</c>：合法档往返 + 每种坏档各判红一次。
/// 之所以能这样测，是因为校验被抽到了 <see cref="TetrisSession"/>（不依赖 JSRuntime / 组件状态）；
/// 原来它只能靠 e2e 的 D24-4 间接覆盖，而 e2e 里"哪一种坏档被哪一道闸拦下"是分不出来的。</para>
/// <para>这里的"合法档"手工构造，不复用组件的随机方块：<b>单测要的是确定的输入输出</b>。</para>
/// </summary>
public class TetrisSessionTests
{
    // ─────────────────────── 构造合法的基线快照 ───────────────────────

    private static int[][] EmptyGrid()
    {
        var g = new int[TetrisSession.GridHeight][];
        for (var i = 0; i < g.Length; i++) g[i] = new int[TetrisSession.GridWidth];
        return g;
    }

    /// <summary>一块 O 形（2×2），作为"当前块"。</summary>
    private static int[][] O() => new[] { new[] { 1, 1 }, new[] { 1, 1 } };

    /// <summary>一块 I 形（1×4），作为"预览块"。</summary>
    private static int[][] I() => new[] { new[] { 1, 1, 1, 1 } };

    /// <summary>合法基线：空盘、O 形在第 0 行、分数 120、等级 2、速度 900。</summary>
    private static TetrisSnapshot Valid() => new()
    {
        V = TetrisSnapshot.CurrentVersion,
        Grid = EmptyGrid(),
        Piece = O(),
        PieceIndex = 3,
        X = 3,
        Y = 0,
        Next = I(),
        NextIndex = 5,
        Score = 120,
        Level = 2,
        Speed = 900
    };

    // ─────────────────────── ① 合法档：往返 + 校验 ───────────────────────

    [Fact]
    public void Valid_RoundTripsThroughJson()
    {
        var original = Valid();

        var json = JsonSerializer.Serialize(original);
        var back = JsonSerializer.Deserialize<TetrisSnapshot>(json);

        Assert.NotNull(back);
        Assert.True(TetrisSession.IsValid(back));
        Assert.Equal(original.V, back!.V);
        Assert.Equal(original.PieceIndex, back.PieceIndex);
        Assert.Equal(original.X, back.X);
        Assert.Equal(original.Y, back.Y);
        Assert.Equal(original.NextIndex, back.NextIndex);
        Assert.Equal(original.Score, back.Score);
        Assert.Equal(original.Level, back.Level);
        Assert.Equal(original.Speed, back.Speed);
        Assert.Equal(TetrisSession.GridHeight, back.Grid!.Length);
        Assert.Equal(TetrisSession.GridWidth, back.Grid[0].Length);
        Assert.Equal(new[] { 1, 1 }, back.Piece![0]);
        Assert.Equal(new[] { 1, 1, 1, 1 }, back.Next![0]);
    }

    /// <summary>线上键名必须是短名 —— 载荷每秒写一次，字段名也算体积；同时钉住"改键名 = 旧档作废"这条契约。</summary>
    [Fact]
    public void Json_UsesShortPropertyNames()
    {
        var json = JsonSerializer.Serialize(Valid());

        foreach (var name in new[] { "\"v\"", "\"grid\"", "\"piece\"", "\"pieceIndex\"", "\"x\"", "\"y\"", "\"next\"", "\"nextIndex\"", "\"score\"", "\"level\"", "\"speed\"" })
        {
            Assert.Contains(name, json);
        }
    }

    // ─────────────────────── ② 坏档逐条判红（每道闸一条）───────────────────────

    [Fact]
    public void Rejects_Null() => Assert.False(TetrisSession.IsValid(null));

    [Fact]
    public void Rejects_WrongVersion()
    {
        var s = Valid();
        s.V = 2;
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_MissingGrid()
    {
        var s = Valid();
        s.Grid = null;
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_GridRowCount()
    {
        var s = Valid();
        s.Grid = new int[TetrisSession.GridHeight - 1][];
        for (var i = 0; i < s.Grid.Length; i++) s.Grid[i] = new int[TetrisSession.GridWidth];
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_GridColumnCount()
    {
        var s = Valid();
        s.Grid![7] = new int[TetrisSession.GridWidth - 1];
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_GridCellOutOfRange()
    {
        var s = Valid();
        s.Grid![19][9] = 8;                     // 上界是 7（= BlockKindCount），8 说明档被改过
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_MissingPiece()
    {
        var s = Valid();
        s.Piece = null;
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_RaggedPieceMatrix()
    {
        var s = Valid();
        s.Piece = new[] { new[] { 1, 1 }, new[] { 1 } };   // 行不等长
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_PieceCellNotBinary()
    {
        var s = Valid();
        s.Piece![0][0] = 2;
        Assert.False(TetrisSession.IsValid(s));
    }

    /// <summary>全 0 矩阵能通过碰撞判定（没有任何格子参与）→ 恢复后是个看不见的方块，必须挡掉。</summary>
    [Fact]
    public void Rejects_EmptyPieceMatrix()
    {
        var s = Valid();
        s.Piece = new[] { new[] { 0, 0 }, new[] { 0, 0 } };
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_OversizedPieceMatrix()
    {
        var s = Valid();
        s.Piece = new[] { new[] { 1, 1, 1, 1, 1 } };        // 5 列，超过俄罗斯方块的最大外接矩阵
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_MissingNext()
    {
        var s = Valid();
        s.Next = null;
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_XOutOfRange()
    {
        var s = Valid();
        s.X = TetrisSession.GridWidth;      // 10：越右边界
        Assert.False(TetrisSession.IsValid(s));

        s.X = -1;
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_NegativeY()
    {
        var s = Valid();
        s.Y = -1;
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_NegativeScore()
    {
        var s = Valid();
        s.Score = -1;
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_ScoreAboveCap()
    {
        var s = Valid();
        s.Score = TetrisSession.MaxScore + 1;
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_LevelBelowOne()
    {
        var s = Valid();
        s.Level = 0;
        Assert.False(TetrisSession.IsValid(s));
    }

    /// <summary>speed &lt; 100 与 IncreaseDifficulty 的地板不一致；speed = 0 还会让 System.Timers.Timer 构造抛。</summary>
    [Fact]
    public void Rejects_SpeedBelowFloor()
    {
        var s = Valid();
        s.Speed = TetrisSession.MinSpeed - 1;
        Assert.False(TetrisSession.IsValid(s));
    }

    /// <summary>合法对局的速度只降不升，高于初速一定是改过的档。</summary>
    [Fact]
    public void Rejects_SpeedAboveInitial()
    {
        var s = Valid();
        s.Speed = TetrisSession.MaxSpeed + 1;
        Assert.False(TetrisSession.IsValid(s));
    }

    /// <summary>颜色索引越界会让 overlay 取调色板时 IndexOutOfRange。</summary>
    [Fact]
    public void Rejects_ColorIndexOutOfRange()
    {
        var s = Valid();
        s.PieceIndex = TetrisSession.BlockKindCount;
        Assert.False(TetrisSession.IsValid(s));

        var s2 = Valid();
        s2.NextIndex = -1;
        Assert.False(TetrisSession.IsValid(s2));
    }

    // ─────────────────────── ③ 碰撞闸（唯一一条"依赖棋盘"的闸）───────────────────────

    [Fact]
    public void Rejects_WhenSpawnPositionCollides()
    {
        var s = Valid();
        s.Grid![0][3] = 4;                  // 与 O 形左上角重叠
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Rejects_WhenPieceOverflowsRightEdge()
    {
        var s = Valid();
        s.X = 9;                            // O 形宽 2 → 第 10 列越界
        Assert.False(TetrisSession.IsValid(s));
    }

    [Fact]
    public void Accepts_WhenOverlapIsAboveGridTop()
    {
        // y = -1 由坐标闸先挡（y ≥ 0）。这里验的是"顶部以上不算碰撞"这条规则本身：
        // 矩阵第 0 行全 0、有块的从第 1 行开始，y = 0 时位置合法。
        var s = Valid();
        s.Piece = new[] { new[] { 0, 0 }, new[] { 1, 1 } };
        s.Y = 0;
        Assert.True(TetrisSession.IsValid(s));
    }

    // ─────────────────────── ④ 矩阵校验的独立契约 ───────────────────────

    // 注：交错数组不能当特性实参（CS0182），故不用 [Theory]/[InlineData]，改为逐条 Fact。

    [Fact]
    public void IsBlockMatrix_AcceptsI()
        => Assert.True(TetrisSession.IsBlockMatrix(new[] { new[] { 1, 1, 1, 1 } }));

    [Fact]
    public void IsBlockMatrix_AcceptsJ()
        => Assert.True(TetrisSession.IsBlockMatrix(new[] { new[] { 1, 0, 0 }, new[] { 1, 1, 1 } }));

    [Fact]
    public void IsBlockMatrix_AcceptsDegenerateSingleCell()
        => Assert.True(TetrisSession.IsBlockMatrix(new[] { new[] { 1 } }));

    [Fact]
    public void IsBlockMatrix_RejectsAllZero()
        => Assert.False(TetrisSession.IsBlockMatrix(new[] { new[] { 0 } }));

    [Fact]
    public void IsBlockMatrix_RejectsEmptyRow()
        => Assert.False(TetrisSession.IsBlockMatrix(new[] { new[] { 1, 0 }, Array.Empty<int>() }));

    [Fact]
    public void IsBlockMatrix_RejectsNull()
        => Assert.False(TetrisSession.IsBlockMatrix(null));
}
