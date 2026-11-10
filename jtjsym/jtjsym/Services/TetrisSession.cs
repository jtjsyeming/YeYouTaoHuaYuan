using System.Text.Json.Serialization;

namespace jtjsym.Services;

/// <summary>
/// 俄罗斯方块对局快照（《33》D-24b）：<c>sessionStorage['jtjsym.tetris.session']</c> 的载荷。
/// <para>字段刻意全部是 <b>已固化的结果</b>而非"操作序列"：<c>Piece</c> 存旋转后的实际矩阵（不存形状索引 + 旋转次数），
/// 恢复时无需重放，也就不会因为将来改旋转规则而读错旧档。</para>
/// <para>用 <c>{ get; set; }</c> 而非 <c>init</c>：反射反序列化零悬念（本项目无 source generator）；
/// 数组字段可为 null —— 缺字段的合法 JSON 会走到这条分支，必须靠校验挡掉而不是 NRE。</para>
/// </summary>
public sealed class TetrisSnapshot
{
    /// <summary>载荷版本。<b>只增不改</b>：结构一变就升版本，旧档自然整档作废（不写迁移代码）。</summary>
    public const int CurrentVersion = 1;

    [JsonPropertyName("v")] public int V { get; set; }
    [JsonPropertyName("grid")] public int[][]? Grid { get; set; }
    [JsonPropertyName("piece")] public int[][]? Piece { get; set; }
    [JsonPropertyName("pieceIndex")] public int PieceIndex { get; set; }
    [JsonPropertyName("x")] public int X { get; set; }
    [JsonPropertyName("y")] public int Y { get; set; }
    [JsonPropertyName("next")] public int[][]? Next { get; set; }
    [JsonPropertyName("nextIndex")] public int NextIndex { get; set; }
    [JsonPropertyName("score")] public int Score { get; set; }
    [JsonPropertyName("level")] public int Level { get; set; }
    [JsonPropertyName("speed")] public int Speed { get; set; }
}

/// <summary>
/// 快照校验与碰撞判定（D-24b §2.3 的"结构闸 + 内容闸"）。
/// <para>抽成纯函数的目的只有一个：让 <c>jtjsym.Tests</c> 能逐条断言"坏档必被拒"。
/// 组件侧只做"校验通过 → 覆盖字段"，判据本身不再散落在 <c>@code</c> 里
/// （对齐 P-019 把 <c>IsValidArchive</c> 迁进 <see cref="Game2048Core"/> 的做法）。</para>
/// <para>本类不依赖 UI / JSRuntime：输入只有数组，输出只有 bool。</para>
/// </summary>
public static class TetrisSession
{
    /// <summary>棋盘尺寸。组件的 <c>GRID_WIDTH/GRID_HEIGHT</c> 直接引用这两个常量（单一来源）。</summary>
    public const int GridWidth = 10;
    public const int GridHeight = 20;

    /// <summary>方块种类数 = 组件 <c>SHAPES.Length</c>：格值 1..7 即 索引 0..6 加一。</summary>
    public const int BlockKindCount = 7;

    /// <summary>速度地板，与 <c>IncreaseDifficulty()</c> 的 <c>Math.Max(100, …)</c> 同值。
    /// 低于它说明档被改过；等于 0 还会让 <c>System.Timers.Timer</c> 构造直接抛。</summary>
    public const int MinSpeed = 100;

    /// <summary>速度上限 = <c>INITIAL_SPEED</c>：合法对局的速度只降不升。</summary>
    public const int MaxSpeed = 1000;

    /// <summary>分数上限（防伪造档把最高分抬到溢出附近）。</summary>
    public const int MaxScore = 999999;

    /// <summary>
    /// 快照是否可恢复。任一条不过 → 整档丢弃、照常开新局（<b>不降级为部分恢复</b>）。
    /// 顺序与《33》§2.3 一致：版本 → 棋盘 → 方块矩阵 → 坐标 → 计分三件 → 索引 → 出生位碰撞。
    /// </summary>
    public static bool IsValid(TetrisSnapshot? s)
    {
        if (s is null) return false;

        // ① 版本闸
        if (s.V != TetrisSnapshot.CurrentVersion) return false;

        // ② 棋盘：恰 20 行 × 10 列，格值 ∈ [0, 7]（0=空，1..7=颜色索引+1）
        var grid = s.Grid;
        if (grid is null || grid.Length != GridHeight) return false;
        foreach (var row in grid)
        {
            if (row is null || row.Length != GridWidth) return false;
            foreach (var v in row)
            {
                if (v < 0 || v > BlockKindCount) return false;
            }
        }

        // ③ 当前块 / 预览块：非空、矩形、值 ∈ {0,1}、边长 ≤ 4（俄罗斯方块的最大外接矩阵）
        var piece = s.Piece;
        if (!IsBlockMatrix(piece)) return false;
        if (!IsBlockMatrix(s.Next)) return false;

        // ④ 坐标：x 在列范围内，y 不低于棋盘顶
        if (s.X < 0 || s.X >= GridWidth) return false;
        if (s.Y < 0) return false;

        // ⑤ 计分三件：分数非负且有上界、等级 ≥ 1、速度落在 [地板, 初速]
        if (s.Score < 0 || s.Score > MaxScore) return false;
        if (s.Level < 1) return false;
        if (s.Speed < MinSpeed || s.Speed > MaxSpeed) return false;

        // ⑥ 颜色索引：决定 overlay 取哪一格调色板，越界会 IndexOutOfRange
        if (s.PieceIndex < 0 || s.PieceIndex >= BlockKindCount) return false;
        if (s.NextIndex < 0 || s.NextIndex >= BlockKindCount) return false;

        // ⑦ 碰撞重算：出生位即碰撞说明这份档来自崩溃边缘 → 整档丢弃。
        //    注意这里**不重算"是否游戏结束"**（2048 的 D-17 需要，Tetris 不需要：
        //    对局结束态的档根本不会存在 —— GameOver 的第一件事就是 removeItem）。
        return !Collides(grid, piece!, s.X, s.Y);
    }

    /// <summary>
    /// 方块矩阵校验：非 null、行数 1..4、每行等长且列数 1..4、值只允许 0/1、至少有一个 1。
    /// "至少一格"不可省：全 0 的矩阵能通过碰撞判定（没有任何格子参与），恢复后就是一个看不见的方块。
    /// </summary>
    public static bool IsBlockMatrix(int[][]? m)
    {
        if (m is null || m.Length is < 1 or > 4) return false;

        var cols = m[0]?.Length ?? 0;
        if (cols is < 1 or > 4) return false;

        var filled = 0;
        foreach (var row in m)
        {
            if (row is null || row.Length != cols) return false;
            foreach (var v in row)
            {
                if (v is not (0 or 1)) return false;
                filled += v;
            }
        }
        return filled > 0;
    }

    /// <summary>
    /// 碰撞判定（与组件内 <c>CheckCollision</c> 同一实现，组件改为转发到这里）。
    /// 越界（左/右/底）算碰撞，<b>顶部以上不算</b>（占据行仍在盘外、尚未落子）。
    /// </summary>
    public static bool Collides(int[][] grid, int[][] piece, int offX, int offY)
    {
        for (var row = 0; row < piece.Length; row++)
        {
            var prow = piece[row];
            for (var col = 0; col < prow.Length; col++)
            {
                if (prow[col] != 1) continue;

                var nx = offX + col;
                var ny = offY + row;

                if (nx < 0 || nx >= GridWidth || ny >= GridHeight) return true;
                if (ny >= 0 && grid[ny][nx] > 0) return true;
            }
        }
        return false;
    }
}
