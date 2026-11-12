using System.Text.Json.Serialization;

namespace jtjsym.Services;

/// <summary>
/// 扫雷难度档（《34》§4.2）。做成数据而不是散落的 <c>if</c>，是因为它同时被三处消费：
/// 页面的难度下拉、<see cref="MinesweeperCore.NewGame(MinesweeperLevel,System.Random)"/>、
/// 以及 <see cref="MinesweeperCore.TryFrom"/> 的结构闸（档位与尺寸/雷数必须自洽）。
/// </summary>
public sealed class MinesweeperLevel
{
    public MinesweeperLevel(string key, string label, int rows, int cols, int mineCount)
    {
        Key = key;
        Label = label;
        Rows = rows;
        Cols = cols;
        MineCount = mineCount;
    }

    /// <summary>存储与快照用的稳定标识（改它等于让所有旧档作废，别改）。</summary>
    public string Key { get; }

    /// <summary>UI 文案。</summary>
    public string Label { get; }

    public int Rows { get; }
    public int Cols { get; }
    public int MineCount { get; }

    public int CellCount => Rows * Cols;
}

public static class MinesweeperLevels
{
    /// <summary>初级 9×9 / 10 雷。</summary>
    public static readonly MinesweeperLevel Beginner = new("beginner", "初级 9×9", 9, 9, 10);

    /// <summary>中级 16×16 / 40 雷。高级（16×30）不做 —— 320px 下 9px/格，必撞 NF-02b。</summary>
    public static readonly MinesweeperLevel Intermediate = new("intermediate", "中级 16×16", 16, 16, 40);

    public static readonly MinesweeperLevel[] All = { Beginner, Intermediate };

    /// <summary>按 <see cref="MinesweeperLevel.Key"/> 找档；未知 key 返回 null（快照结构闸用）。</summary>
    public static MinesweeperLevel? ByKey(string? key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        foreach (var lv in All)
        {
            if (lv.Key == key) return lv;
        }
        return null;
    }
}

/// <summary>
/// 扫雷对局快照：<c>sessionStorage['jtjsym.ms.session']</c> 的载荷（《34》§4.5）。
/// <para>棋盘用<b>一维数组 + rows/cols</b>：<c>int[,]</c> 不能直接序列化，而交错数组会让"长度是否等于 rows×cols"
/// 这道结构闸变成一句 <c>Length</c> 比较就能挡住的判据。</para>
/// <para>格值编码（<see cref="Cells"/>）：<c>-2</c> 未翻的雷、<c>-1</c> 未翻的空白、<c>0..8</c> 已翻的相邻雷数。
/// <b>不设 <c>9</c>=已翻的雷</b>：败局的第一件事就是清档，合法档里永远不会出现"翻开的雷"，
/// 于是它天然成为一条内容闸（见 <see cref="MinesweeperCore.TryFrom"/>）。</para>
/// <para>用 <c>{ get; set; }</c> 而非 <c>init</c>：反射反序列化零悬念（本项目无 source generator）；
/// 数组字段可为 null —— 缺字段的合法 JSON 会走到这条分支，必须靠校验挡掉而不是 NRE。</para>
/// </summary>
public sealed class MinesweeperSnapshot
{
    /// <summary>载荷版本。<b>只增不改</b>：结构一变就升版本，旧档自然整档作废（不写迁移代码）。</summary>
    public const int CurrentVersion = 1;

    [JsonPropertyName("v")] public int V { get; set; }
    [JsonPropertyName("rows")] public int Rows { get; set; }
    [JsonPropertyName("cols")] public int Cols { get; set; }
    [JsonPropertyName("mineCount")] public int MineCount { get; set; }
    [JsonPropertyName("difficulty")] public string? Difficulty { get; set; }
    [JsonPropertyName("elapsedSec")] public int ElapsedSec { get; set; }
    [JsonPropertyName("minesPlaced")] public bool MinesPlaced { get; set; }
    [JsonPropertyName("cells")] public int[]? Cells { get; set; }
    [JsonPropertyName("flags")] public bool[]? Flags { get; set; }
}

/// <summary>
/// 扫雷的纯逻辑内核（《34》§2.2）：不依赖 UI / JSRuntime，输入只有坐标与 <see cref="Random"/>，
/// 因此 <c>jtjsym.Tests</c> 能对"首点安全""雷数精确""坏档必被拒"逐条断言。
/// <para><b>随机数由调用方注入</b>：对齐 <c>Game2048Core.SpawnValue(Random rng, …)</c> 的既有约定，
/// 否则"首点安全""雷数精确"只能靠概率断言。</para>
/// <para>布雷时机：<b>首次翻开才布雷</b>（首点安全的前提）。在此之前 <see cref="MinesPlaced"/> 为 false，
/// 快照里所有格都是 <c>-1</c>。</para>
/// </summary>
public sealed class MinesweeperCore
{
    /// <summary>用时上界（秒）：一天。<c>elapsedSec</c> 是显示用计时，越界说明档被改过。</summary>
    public const int MaxElapsedSec = 86400;

    private readonly int[] _adjacent;   // 相邻雷数，仅对非雷格有意义（雷格留 0）
    private readonly bool[] _mines;
    private readonly bool[] _revealed;
    private readonly bool[] _flags;
    private readonly Random _rng;

    private MinesweeperCore(MinesweeperLevel level, Random rng)
    {
        Level = level;
        _rng = rng;
        _adjacent = new int[level.CellCount];
        _mines = new bool[level.CellCount];
        _revealed = new bool[level.CellCount];
        _flags = new bool[level.CellCount];
    }

    public MinesweeperLevel Level { get; }

    public int Rows => Level.Rows;
    public int Cols => Level.Cols;
    public int MineCount => Level.MineCount;

    /// <summary>是否已经布雷（首次翻开后为 true）。</summary>
    public bool MinesPlaced { get; private set; }

    public bool IsWin { get; private set; }
    public bool IsLose { get; private set; }
    public bool IsOver => IsWin || IsLose;

    public int FlagCount
    {
        get
        {
            var n = 0;
            foreach (var f in _flags) if (f) n++;
            return n;
        }
    }

    /// <summary>已翻开的<b>安全</b>格数（踩中的雷不计）。</summary>
    public int RevealedSafeCount
    {
        get
        {
            var n = 0;
            for (var i = 0; i < _revealed.Length; i++)
            {
                if (_revealed[i] && !_mines[i]) n++;
            }
            return n;
        }
    }

    /// <summary>剩余雷数 = 雷数 − 旗数。<b>可为负</b>、显示原值（《34》§4.2 末行）。</summary>
    public int RemainingMines => MineCount - FlagCount;

    /// <summary>
    /// 开新局。参数越界的判断放在这里而不是到处 <c>if</c>：雷数必须 ≥1，
    /// 且要能给首点的 3×3 禁区留出余量（否则首点安全无法保证）。
    /// </summary>
    public static MinesweeperCore NewGame(MinesweeperLevel level, Random rng)
    {
        ArgumentNullException.ThrowIfNull(level);
        ArgumentNullException.ThrowIfNull(rng);

        // 首点禁区最坏 9 格（边角更少），所以可用格 = CellCount − 9 是保守下界
        if (level.MineCount < 1 || level.MineCount > level.CellCount - 9)
        {
            throw new ArgumentOutOfRangeException(nameof(level),
                $"雷数 {level.MineCount} 超出 [{1}, {level.CellCount - 9}]：首点 3×3 禁区会被迫布雷");
        }
        return new MinesweeperCore(level, rng);
    }

    public static MinesweeperCore NewGame(int rows, int cols, int mineCount, Random rng) =>
        NewGame(new MinesweeperLevel("custom", "自定义", rows, cols, mineCount), rng);

    private bool InBounds(int r, int c) => r >= 0 && r < Rows && c >= 0 && c < Cols;

    private int Index(int r, int c) => r * Cols + c;

    public bool IsMine(int r, int c) => InBounds(r, c) && _mines[Index(r, c)];
    public bool IsRevealed(int r, int c) => InBounds(r, c) && _revealed[Index(r, c)];
    public bool IsFlagged(int r, int c) => InBounds(r, c) && _flags[Index(r, c)];

    /// <summary>相邻雷数。未布雷时为 0；雷格本身返回 0（无意义，调用方不该问）。</summary>
    public int Adjacent(int r, int c) => InBounds(r, c) ? _adjacent[Index(r, c)] : 0;

    /// <summary>
    /// 翻开一格。返回"状态是否有变化"（调用方据此决定要不要落盘）。
    /// 已结束 / 越界 / 已插旗 / 已翻开 → false，且不产生任何副作用。
    /// <para>首点在此布雷，并把首格 + 8 邻域列为禁区 —— 推论：首格相邻雷数恒为 0 ⇒ <b>首点必然触发洪泛</b>，
    /// 所以"首点后翻开数 &gt; 1"是硬结论而不是概率。</para>
    /// </summary>
    public bool Reveal(int r, int c)
    {
        if (IsOver || !InBounds(r, c)) return false;

        var i = Index(r, c);
        if (_revealed[i] || _flags[i]) return false;

        if (!MinesPlaced) PlaceMines(r, c);

        if (_mines[i])
        {
            _revealed[i] = true;
            IsLose = true;
            return true;
        }

        FloodReveal(r, c);
        if (RevealedSafeCount == Level.CellCount - MineCount) IsWin = true;
        return true;
    }

    /// <summary>插旗/取消插旗。已翻开格与结束态一律拒绝（对齐"两态、无问号循环"的设计）。</summary>
    public bool ToggleFlag(int r, int c)
    {
        if (IsOver || !InBounds(r, c)) return false;

        var i = Index(r, c);
        if (_revealed[i]) return false;

        _flags[i] = !_flags[i];
        return true;
    }

    private void PlaceMines(int firstRow, int firstCol)
    {
        MinesPlaced = true;

        // 禁区 = 首格 + 8 邻域。每格只与自己的邻域比较，越界自然跳过。
        var forbidden = new bool[Level.CellCount];
        for (var dr = -1; dr <= 1; dr++)
        {
            for (var dc = -1; dc <= 1; dc++)
            {
                var r = firstRow + dr;
                var c = firstCol + dc;
                if (InBounds(r, c)) forbidden[Index(r, c)] = true;
            }
        }

        var candidates = new List<int>(Level.CellCount);
        for (var i = 0; i < forbidden.Length; i++)
        {
            if (!forbidden[i]) candidates.Add(i);
        }

        // 部分洗牌：只需前 MineCount 个位置，Fisher-Yates 走前 k 步即可
        for (var k = 0; k < MineCount; k++)
        {
            var j = _rng.Next(k, candidates.Count);
            (candidates[k], candidates[j]) = (candidates[j], candidates[k]);
            _mines[candidates[k]] = true;
        }

        for (var r = 0; r < Rows; r++)
        {
            for (var c = 0; c < Cols; c++)
            {
                if (_mines[Index(r, c)]) continue;
                _adjacent[Index(r, c)] = CountAdjacentMines(r, c);
            }
        }
    }

    private int CountAdjacentMines(int r, int c)
    {
        var n = 0;
        for (var dr = -1; dr <= 1; dr++)
        {
            for (var dc = -1; dc <= 1; dc++)
            {
                if (dr == 0 && dc == 0) continue;
                var rr = r + dr;
                var cc = c + dc;
                if (InBounds(rr, cc) && _mines[Index(rr, cc)]) n++;
            }
        }
        return n;
    }

    /// <summary>
    /// 8 邻域洪泛：0 格继续扩散，数字格只翻开自身（成为展开区的边界）。
    /// 用显式栈而不是递归 —— 中级 256 格的最坏情形成片展开，递归深度不必要地深。
    /// 已插旗的格**阻止**扩散（与主流实现一致：旗子代表"玩家认定这是雷"）。
    /// </summary>
    private void FloodReveal(int r, int c)
    {
        var stack = new Stack<int>();
        stack.Push(Index(r, c));

        while (stack.Count > 0)
        {
            var i = stack.Pop();
            if (_revealed[i] || _flags[i] || _mines[i]) continue;
            _revealed[i] = true;

            if (_adjacent[i] != 0) continue;

            var cr = i / Cols;
            var cc = i % Cols;
            for (var dr = -1; dr <= 1; dr++)
            {
                for (var dc = -1; dc <= 1; dc++)
                {
                    if (dr == 0 && dc == 0) continue;
                    var rr = cr + dr;
                    var nc = cc + dc;
                    if (InBounds(rr, nc)) stack.Push(Index(rr, nc));
                }
            }
        }
    }

    // ───────────────────────── 快照 ─────────────────────────

    /// <summary>行主序拍平成 <see cref="MinesweeperSnapshot.Cells"/>（与 <c>r * Cols + c</c> 同序，不会转置）。</summary>
    public int[] ToFlatCells()
    {
        var cells = new int[Level.CellCount];
        for (var i = 0; i < cells.Length; i++)
        {
            cells[i] = _mines[i]
                ? (_revealed[i] ? 9 : -2)   // 9 只会在败局出现，而败局不写档（见类注释）
                : (_revealed[i] ? _adjacent[i] : -1);
        }
        return cells;
    }

    public bool[] ToFlatFlags() => (bool[])_flags.Clone();

    public MinesweeperSnapshot ToSnapshot(int elapsedSec) => new()
    {
        V = MinesweeperSnapshot.CurrentVersion,
        Rows = Rows,
        Cols = Cols,
        MineCount = MineCount,
        Difficulty = Level.Key,
        ElapsedSec = elapsedSec,
        MinesPlaced = MinesPlaced,
        Cells = ToFlatCells(),
        Flags = ToFlatFlags(),
    };

    /// <summary>
    /// 快照是否可恢复。<b>任一条不过 → 返回 null（整档丢弃、照常开新局），不降级为部分恢复</b>
    /// （对齐 D-18 / D-24 的"结构闸 + 内容闸"口径）。顺序：
    /// 版本 → 档位自洽（rows/cols/mineCount 必须与档位一致）→ 长度 → 格值域 → 旗位合法 → 布雷态 → 数字一致性。
    /// </summary>
    public static MinesweeperCore? TryFrom(MinesweeperSnapshot? s)
    {
        // ① 版本闸
        if (s is null || s.V != MinesweeperSnapshot.CurrentVersion) return null;

        // ② 档位闸：尺寸与雷数必须正好等于某个已知档位 —— 只校验"长度等于 rows*cols"挡不住伪造的 5×5/999 雷
        var level = MinesweeperLevels.ByKey(s.Difficulty);
        if (level is null) return null;
        if (s.Rows != level.Rows || s.Cols != level.Cols || s.MineCount != level.MineCount) return null;

        // ③ 结构闸：两个数组都得在、且长度恰为 rows×cols（缺字段的合法 JSON 会走到 null 分支）
        var n = level.CellCount;
        if (s.Cells is null || s.Cells.Length != n) return null;
        if (s.Flags is null || s.Flags.Length != n) return null;
        if (s.ElapsedSec < 0 || s.ElapsedSec > MaxElapsedSec) return null;

        // ④ 格值域：-2 未翻雷、-1 未翻空、0..8 已翻数字。9（已翻雷）说明这是败局档 —— 拒绝
        foreach (var v in s.Cells)
        {
            if (v < -2 || v > 8) return null;
        }

        // ⑤ 旗位：只能落在未翻格（已翻格上插旗是半截写入的典型形态）
        for (var i = 0; i < n; i++)
        {
            if (s.Flags[i] && s.Cells[i] >= 0) return null;
        }

        var core = new MinesweeperCore(level, new Random(0));   // rng 不参与恢复，随便给

        if (!s.MinesPlaced)
        {
            // ⑥ 未布雷：不可能有任何雷标记或已翻格
            foreach (var v in s.Cells)
            {
                if (v != -1) return null;
            }
        }
        else
        {
            // ⑦ 雷数一致
            var mines = 0;
            foreach (var v in s.Cells) if (v == -2) mines++;
            if (mines != level.MineCount) return null;

            // ⑧ 胜局不写档（Reveal 一置 IsWin 就清档）⇒ 合法档必未胜
            var revealedSafe = 0;
            foreach (var v in s.Cells) if (v >= 0) revealedSafe++;
            if (revealedSafe >= n - level.MineCount) return null;
        }

        // 落库
        for (var i = 0; i < n; i++)
        {
            var v = s.Cells[i];
            core._mines[i] = v == -2;
            core._revealed[i] = v >= 0;
            core._adjacent[i] = v >= 0 ? v : 0;
            core._flags[i] = s.Flags[i];
        }

        // ⑨ 数字一致性：已翻格的数字必须等于其邻域的实际雷数（内容闸，挡得住"拔掉一颗雷"这类伪造）
        for (var r = 0; r < level.Rows; r++)
        {
            for (var c = 0; c < level.Cols; c++)
            {
                var i = core.Index(r, c);
                if (!core._revealed[i] || core._mines[i]) continue;
                if (core._adjacent[i] != core.CountAdjacentMines(r, c)) return null;
            }
        }

        // ⑩ 邻值重建（D-26）：_adjacent 必须对**全部非雷格**成立，FloodReveal 才能在正确的位置停住。
        // 落库那一步把未翻格（-1）的邻值一律写成 0，而 FloodReveal 正是靠 `_adjacent[i] != 0` 停止扩散 ——
        // 不重建的话恢复局里每个未翻格都像"零格"，点任何一个安全格都会展开整片连通区（连到 71 格即伪胜局）。
        // ⚠ 位置是硬约束：必须排在 ⑨ 之后。⑨ 的判据是"快照里的数字 vs 实际邻雷数"，
        //    先重算会让两边恒等、内容闸退化成空操作（Rejects_AdjacentCountMismatch 会当场变红）。
        for (var r = 0; r < level.Rows; r++)
        {
            for (var c = 0; c < level.Cols; c++)
            {
                var i = core.Index(r, c);
                if (!core._mines[i]) core._adjacent[i] = core.CountAdjacentMines(r, c);
            }
        }

        core.MinesPlaced = s.MinesPlaced;
        return core;
    }

    // ───────────────────────── 最快时间（秒，越小越好） ─────────────────────────
    // 这两个口径原本写在 MineSweeper.razor 里，只能靠 e2e 撞；下沉到 Core 后一条单测就能钉死（《35》§2.2）。

    /// <summary>
    /// 解析 localStorage 里的最快时间。比较方向与 2048/Tetris <b>相反</b>（越小越好），
    /// 所以照抄"越大越好 + 0 无效"会直接写反。
    /// <para>0 是否有效取决于胜局处的钳位：当前实现把 0 钳成 1（方案 A），故 0 仍是无效值（<c>v &gt; 0</c>）。</para>
    /// </summary>
    public static int? TryParseBest(string? raw) =>
        int.TryParse(raw, out var v) && v > 0 ? v : null;

    /// <summary>
    /// 返回<b>新的纪录值</b>；不需要刷新时返回 null（页面据此决定遮罩要不要显示「新纪录！」）。
    /// <para>相等不刷新：给"同一份档重放"一个确定的语义，也避免无谓的写盘。</para>
    /// </summary>
    public static int? TryUpdateBest(int? current, int sec) =>
        sec >= 1 && (current is null || sec < current) ? sec : null;
}
