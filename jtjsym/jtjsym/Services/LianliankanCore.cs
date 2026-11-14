using System.Text.Json;
using System.Text.Json.Serialization;

namespace jtjsym.Services;

/// <summary>
/// 连连看的存储键（《36》v2.0 §3.3）：<b>集中在这里，禁止散写</b>。
/// <para>《35》C-59 刚为"键名散落在页面里"付过一次代价（改名要同时改 razor / spec / 文档三处），
/// 所以这次从一开始就把键收进常量。方案 A（本地榜）只有两条键，都不含期号 ——
/// 按日分键一年长 365 条，而产品只需要"今日纪录"，读的时候比一下 <c>issue</c> 即可（《36》v2.1 §4.1）。</para>
/// </summary>
public static class LlkKeys
{
    /// <summary>当日对局进度。<c>sessionStorage</c>。</summary>
    public const string Session = "jtjsym.llk.session";

    /// <summary>今日最快：<c>{"issue":20261112,"sec":87}</c>。<c>localStorage</c>，单键单条。</summary>
    public const string Best = "jtjsym.llk.best";

    /// <summary>
    /// 玩法遮罩是否看过（H-015）：<c>localStorage</c>，"1" = 已看过。
    /// <para>只挡首访：写死"1" 而不是存时间戳 —— 本期不做"重看入口"，
    /// 想看第二遍就清掉这条键（《39》§12 #7）。</para>
    /// </summary>
    public const string RulesSeen = "jtjsym.llk.rulesSeen";
}

/// <summary>
/// 对局快照：<c>sessionStorage['jtjsym.llk.session']</c> 的载荷（《36》v2.0 §3.5）。
/// <para>棋盘一维 48 格，<c>0</c> = 空、<c>1..24</c> = 头像编号。<b>没有派生字段</b> ——
/// 连连看的连通性按需算、不缓存，所以 D-26 那种"恢复时漏重建字段"的缺陷形态在这里不存在；
/// 这道闸要写全的是<b>结构</b>（长度 / 值域 / 成对），不是补丁（《36》v2.0 §3.1 末注）。</para>
/// </summary>
public sealed class LianliankanSnapshot
{
    /// <summary>载荷版本。<b>只增不改</b>：结构一变就升版本，旧档自然整档作废。</summary>
    public const int CurrentVersion = 1;

    [JsonPropertyName("v")] public int V { get; set; }

    /// <summary>期号（<c>yyyyMMdd</c> 的整数，如 20261112）。跨天残留一律整档丢弃。</summary>
    [JsonPropertyName("issue")] public int Issue { get; set; }

    [JsonPropertyName("cells")] public int[]? Cells { get; set; }

    [JsonPropertyName("elapsedSec")] public int ElapsedSec { get; set; }

    /// <summary>
    /// 剩余提示次数（H-015）。<b>可空</b>：旧档没有这个字段，读出来是 <c>null</c> ⇒ 补满 3。
    /// <para><b>不升 <see cref="CurrentVersion"/></b>（《39》§4 拍板 4）：加一个可选字段是向后兼容的结构变化，
    /// 升版本反而要同时把 <c>TryFrom</c> 的"只认当前版本"改成白名单，以后每加一版都得回来改。</para>
    /// </summary>
    [JsonPropertyName("hints")] public int? Hints { get; set; }
}

/// <summary>本地榜的载荷：<c>{"issue":20261112,"sec":87}</c>（《36》v2.1 §4.1）。</summary>
public sealed class LlkBestRecord
{
    [JsonPropertyName("issue")] public int Issue { get; set; }
    [JsonPropertyName("sec")] public int Sec { get; set; }
}

/// <summary>
/// 一条连通路径（H-015 / 《39》§3.1）。
/// <para><see cref="Points"/> 已<b>压缩</b>为只保留端点与拐点：相邻两点必同行或同列，
/// 且 <see cref="Turns"/> 恒等于 <c>Points.Count - 2</c>。盘外坐标（<c>-1</c> 或 <c>Rows</c>/<c>Cols</c>）
/// 会原样保留 —— 那是<b>算法语义</b>；"画在盘边"是渲染层的事（钳制在 JS 里做）。</para>
/// </summary>
public sealed record LlkPath(IReadOnlyList<(int R, int C)> Points, int Turns);

/// <summary>
/// 连连看的纯逻辑内核（《36》v2.0 §3.1）：不依赖 UI / JSRuntime，因此
/// <c>jtjsym.Tests</c> 能对"连通矩阵""每日确定性""坏档必拒"逐条断言。
/// <para><b>随机数不用 <c>System.Random</c></b>：<c>new Random(int)</c> 为兼容沿用 .NET Framework 的减法算法，
/// 微软只给"事实稳定"的承诺。换 .NET 大版本若序列变了，<b>同一期号的盘面就变了</b>，
/// 历史成绩与新盘面不再对应。这里内嵌 40 行 SplitMix64：跨版本恒定、零依赖、可单测。</para>
/// <para><b>可解性只在运行时保证</b>：生成期只做一次 <see cref="HasAnyPair"/> 检查 + 有界重排 + 确定性兜底，
/// 不做"贪心模拟可解"（贪心走到死局 ≠ 盘面无解，而重排兜底等于把死局换成可解盘 —— 那正是运行时
/// <see cref="Reshuffle"/> 干的事，没必要在生成期重来一遍）。</para>
/// </summary>
public sealed class LianliankanCore
{
    public const int Rows = 8;
    public const int Cols = 6;
    public const int CellCount = Rows * Cols;      // 48 = 24 对
    public const int FaceCount = 24;

    /// <summary>用时上界（秒）：一天。越界说明档被改过。</summary>
    public const int MaxElapsedSec = 86400;

    /// <summary>重排上限。超过就进确定性兜底，不"放水"继续摇。</summary>
    private const int ReshuffleLimit = 20;

    /// <summary>最多允许的拐弯数（经典连连看：≤2 拐）。<b>public</b>：页面要用它按 <c>Turns</c> 分流（H-015）。</summary>
    public const int TurnLimit = 2;

    /// <summary>每局提示次数（H-015）。</summary>
    public const int HintTotal = 3;

    private static readonly int[] Dr = { -1, 1, 0, 0 };
    private static readonly int[] Dc = { 0, 0, -1, 1 };

    private readonly int[] _cells;
    private readonly Rng _rng;

    private LianliankanCore(int issue, Rng rng)
    {
        Issue = issue;
        _rng = rng;
        _cells = new int[CellCount];
    }

    /// <summary>本局期号。</summary>
    public int Issue { get; }

    /// <summary>剩余方块数（0 = 已通关）。</summary>
    public int RemainingCount { get; private set; }

    /// <summary>剩余提示次数（H-015，默认 <see cref="HintTotal"/>）。<b>只有 <see cref="UseHint"/> 能减</b>。</summary>
    public int HintsLeft { get; private set; } = HintTotal;

    public bool IsCleared => RemainingCount == 0;

    /// <summary>棋盘只读视图（一维、行优先）。测试与序列化用。</summary>
    public IReadOnlyList<int> Cells => _cells;

    // ───────────────────────── 期号 ─────────────────────────

    /// <summary>
    /// 期号 = 北京时间（UTC+8）的 <c>yyyyMMdd</c>。
    /// <para><b>固定偏移，不查系统时区</b>：中国无夏令时、偏移恒 +8；
    /// 而 <c>"China Standard Time"</c> 是 Windows ID、<c>"Asia/Shanghai"</c> 才是 tzdata ID，
    /// CI 是 ubuntu —— 用系统时区纯属自找跨平台麻烦（《36》v2.0 §0 #8）。</para>
    /// <para>时钟由调用方传入（不在这里摸 <c>DateTime.Now</c>），否则"跨日换关"根本没法单测。</para>
    /// </summary>
    public static int IssueFor(DateTimeOffset now) =>
        int.Parse(now.ToOffset(TimeSpan.FromHours(8)).ToString("yyyyMMdd"));

    // ───────────────────────── 生成 ─────────────────────────

    /// <summary>
    /// 按 <paramref name="issue"/> 确定性铺盘：24 个头像各 ×2 → Fisher-Yates → 铺满 48 格。
    /// <para>同一天（同 issue）无论谁来跑，盘面逐格相同 —— 这是"每日一关"的全部技术含义。</para>
    /// </summary>
    public static LianliankanCore NewDaily(int issue)
    {
        var core = new LianliankanCore(issue, Rng.ForIssue(issue));
        core.FillAllShuffled();

        var rounds = 0;
        while (!core.HasAnyPair() && rounds < ReshuffleLimit)
        {
            core.ShuffleRemaining();
            rounds++;
        }

        // 兜底不靠概率：20 次仍无解（理论极罕见）时按确定性规则把一对同号搬到相邻两格。
        if (!core.HasAnyPair()) core.ForcePair();
        return core;
    }

    private void FillAllShuffled()
    {
        var values = new int[CellCount];
        for (var i = 0; i < FaceCount; i++)
        {
            values[i * 2] = i + 1;
            values[i * 2 + 1] = i + 1;
        }

        Shuffle(values);
        Array.Copy(values, _cells, CellCount);
        RemainingCount = CellCount;
    }

    /// <summary>把<b>剩余</b>方块的值在占用格之间重排（占用位置不变 ⇒ 剩余数不变）。</summary>
    private void ShuffleRemaining()
    {
        var slots = new List<int>(CellCount);
        for (var i = 0; i < CellCount; i++)
        {
            if (_cells[i] != 0) slots.Add(i);
        }
        if (slots.Count < 2) return;

        var values = new int[slots.Count];
        for (var i = 0; i < slots.Count; i++) values[i] = _cells[slots[i]];

        Shuffle(values);
        for (var i = 0; i < slots.Count; i++) _cells[slots[i]] = values[i];
    }

    /// <summary>Fisher-Yates（用内嵌 <see cref="Rng"/>，不用 <c>System.Random</c>）。</summary>
    private void Shuffle(int[] values)
    {
        for (var i = values.Length - 1; i > 0; i--)
        {
            var j = _rng.Next(i + 1);
            (values[i], values[j]) = (values[j], values[i]);
        }
    }

    /// <summary>
    /// 确定性兜底：把一对同号搬到两个<b>相邻</b>格（相邻必可连，0 拐）。
    /// <para>优先搬到"两个相邻的已占用格"（连占用集都不动）；没有这种格子时退回
    /// "两个相邻的空格"，把原位置腾空 —— 两条路都保持<b>剩余数与图案多重集不变</b>。</para>
    /// </summary>
    private void ForcePair()
    {
        var (i, j) = FirstPair();
        if (i < 0) return;

        var (a, b) = FirstAdjacent(occupied: true);
        if (a >= 0)
        {
            MovePairTo(i, j, a, b);
            return;
        }

        (a, b) = FirstAdjacent(occupied: false);
        if (a < 0) return;

        // 搬到两个相邻空格：数量与多重集都不变（原两格腾空）
        var face = _cells[i];
        _cells[i] = 0;
        _cells[j] = 0;
        _cells[a] = face;
        _cells[b] = face;
    }

    /// <summary>把 <paramref name="i"/>/<paramref name="j"/> 这一对同号搬到 <paramref name="a"/>/<paramref name="b"/>（交换式，占用集不变）。</summary>
    private void MovePairTo(int i, int j, int a, int b)
    {
        // 先保证 a 上是对子上的一枚，再保证 b
        SwapCells(i, a);
        var other = j == a ? i : j;   // i 与 a 交换后，对子的另一枚可能被换到了 i 上
        SwapCells(other, b);
    }

    private void SwapCells(int x, int y)
    {
        if (x == y) return;
        (_cells[x], _cells[y]) = (_cells[y], _cells[x]);
    }

    private (int I, int J) FirstPair()
    {
        for (var i = 0; i < CellCount; i++)
        {
            if (_cells[i] == 0) continue;
            for (var j = i + 1; j < CellCount; j++)
            {
                if (_cells[j] == _cells[i]) return (i, j);
            }
        }
        return (-1, -1);
    }

    /// <summary>行优先找第一对相邻格：先看右侧、再看下方（4 邻接）。</summary>
    private (int A, int B) FirstAdjacent(bool occupied)
    {
        static int Idx(int r, int c) => r * Cols + c;

        for (var r = 0; r < Rows; r++)
        {
            for (var c = 0; c < Cols; c++)
            {
                var p = Idx(r, c);
                if (occupied ? _cells[p] == 0 : _cells[p] != 0) continue;

                if (c + 1 < Cols)
                {
                    var q = Idx(r, c + 1);
                    if (occupied ? _cells[q] != 0 : _cells[q] == 0) return (p, q);
                }
                if (r + 1 < Rows)
                {
                    var q = Idx(r + 1, c);
                    if (occupied ? _cells[q] != 0 : _cells[q] == 0) return (p, q);
                }
            }
        }
        return (-1, -1);
    }

    // ───────────────────────── 读取与操作 ─────────────────────────

    public static bool InBoard(int r, int c) => r >= 0 && r < Rows && c >= 0 && c < Cols;

    private static int Index(int r, int c) => r * Cols + c;

    /// <summary>格上的头像编号（0 = 空 / 越界）。</summary>
    public int FaceAt(int r, int c) => InBoard(r, c) ? _cells[Index(r, c)] : 0;

    public bool IsEmpty(int r, int c) => !InBoard(r, c) || _cells[Index(r, c)] == 0;

    /// <summary>
    /// 经典 ≤2 拐连通判定：从两格出发逐格扩散，状态带"进入方向 + 已拐弯数"，&gt;2 剪枝。
    /// <para><b>盘外扩 1 圈空边界</b>：从盘外绕行只需贴着边框走一格，1 圈足够；
    /// 少了这一圈，两个贴边同号块会被判"不可连"（这是最常写错的一条）。</para>
    /// <para>用"按拐弯数松弛"而不是纯 BFS：代价不是步数而是拐弯数，步数 BFS 会先到先得、
    /// 把拐弯更少但步数更多的路径漏掉。</para>
    /// </summary>
    public bool CanConnect(int r1, int c1, int r2, int c2)
    {
        if (!InBoard(r1, c1) || !InBoard(r2, c2)) return false;
        if (r1 == r2 && c1 == c2) return false;

        var face = _cells[Index(r1, c1)];
        if (face == 0 || face != _cells[Index(r2, c2)]) return false;

        // 坐标范围 [-1, Rows] × [-1, Cols]：越界一律视为空格（那圈边界）
        var cols = Cols + 2;
        var best = new int[(Rows + 2) * cols * 4];
        Array.Fill(best, int.MaxValue);

        var queue = new Queue<(int R, int C, int D, int T)>();

        bool Blocked(int r, int c) => InBoard(r, c) && _cells[Index(r, c)] != 0;
        int StateIndex(int r, int c, int d) => ((r + 1) * cols + (c + 1)) * 4 + d;
        bool OutOfRange(int r, int c) => r < -1 || r > Rows || c < -1 || c > Cols;

        for (var d = 0; d < 4; d++)
        {
            var nr = r1 + Dr[d];
            var nc = c1 + Dc[d];
            if (OutOfRange(nr, nc)) continue;
            if (nr == r2 && nc == c2) return true;      // 紧贴的同号：0 拐
            if (Blocked(nr, nc)) continue;
            var si = StateIndex(nr, nc, d);
            if (best[si] <= 0) continue;
            best[si] = 0;
            queue.Enqueue((nr, nc, d, 0));
        }

        while (queue.Count > 0)
        {
            var (r, c, d, t) = queue.Dequeue();
            for (var nd = 0; nd < 4; nd++)
            {
                if (nd == (d ^ 1)) continue;            // 原地掉头：白绕一圈，不可能更优
                var nt = nd == d ? t : t + 1;
                if (nt > TurnLimit) continue;

                var nr = r + Dr[nd];
                var nc = c + Dc[nd];
                if (OutOfRange(nr, nc)) continue;
                if (nr == r2 && nc == c2) return true;
                if (Blocked(nr, nc)) continue;

                var si = StateIndex(nr, nc, nd);
                if (best[si] <= nt) continue;
                best[si] = nt;
                queue.Enqueue((nr, nc, nd, nt));
            }
        }

        return false;
    }

    /// <summary>
    /// 带路径的连通判定（H-015 / 《39》§3.1）：<b>一次搜索拿全部信息</b>。
    /// <para><paramref name="maxTurns"/> 只影响剪枝：传 <see cref="TurnLimit"/> = "按判定口径"；
    /// 传 <see cref="int.MaxValue"/> = "只要有路就给最省拐的那条"。调用方<b>只用 MAX 调一次</b>，
    /// 再按 <see cref="LlkPath.Turns"/> 分流（≤2 消除 / ≥3 画虚线 / null 抖动）。</para>
    /// <para>实现是 <b>0-1 BFS</b>（代价是拐数不是步数）：同向 <c>AddFirst</c>、转向 <c>AddLast</c>，
    /// 所以出队顺序按拐数单调不减。用普通步数 BFS 会"先到先得"，把拐更少但路更长的解漏掉。</para>
    /// </summary>
    public LlkPath? TryFindPath(int r1, int c1, int r2, int c2, int maxTurns)
    {
        if (!InBoard(r1, c1) || !InBoard(r2, c2)) return null;
        if (r1 == r2 && c1 == c2) return null;

        var face = _cells[Index(r1, c1)];
        if (face == 0 || face != _cells[Index(r2, c2)]) return null;

        // 与 CanConnect 同一套状态编码：坐标范围 [-1, Rows] × [-1, Cols]，状态 = (r, c, 进入方向)
        var cols = Cols + 2;
        var stateCount = (Rows + 2) * cols * 4;
        var dist = new int[stateCount];
        Array.Fill(dist, int.MaxValue);
        var parent = new int[stateCount];
        Array.Fill(parent, -1);

        bool OutOfRange(int r, int c) => r < -1 || r > Rows || c < -1 || c > Cols;
        bool Blocked(int r, int c) => InBoard(r, c) && _cells[Index(r, c)] != 0;
        int StateIndex(int r, int c, int d) => ((r + 1) * cols + (c + 1)) * 4 + d;
        (int R, int C) CellOf(int s)
        {
            var p = s / 4;
            return (p / cols - 1, p % cols - 1);
        }

        // ⚠ 回溯后必须补起点：起点状态记 -1 当哨兵，parent 链里**没有起点本身**（《39》§3.2 实现坑）。
        //   只按 parent 回溯会少掉第一段、Turns 也算错。
        LlkPath Build(int endState)
        {
            var raw = new List<(int R, int C)>();
            for (var s = endState; s >= 0; s = parent[s]) raw.Add(CellOf(s));
            raw.Reverse();
            raw.Insert(0, (r1, c1));
            raw.Add((r2, c2));

            // 压缩：只保留端点与拐点。先按"完全重合"去重，再按方向是否改变判定 ——
            // Math.Sign(0) == 0 会把"水平段接水平段"和"水平段接垂直段"混在一起，所以必须先去掉零长段。
            var pts = new List<(int R, int C)>(raw.Count);
            foreach (var p in raw)
            {
                if (pts.Count > 0 && pts[^1] == p) continue;
                if (pts.Count >= 2)
                {
                    var prev = pts[^2];
                    var last = pts[^1];
                    if (Math.Sign(last.R - prev.R) == Math.Sign(p.R - last.R) &&
                        Math.Sign(last.C - prev.C) == Math.Sign(p.C - last.C))
                    {
                        pts[^1] = p;                       // 同向：把中间点吃掉
                        continue;
                    }
                }
                pts.Add(p);
            }

            // Turns 由压缩后的点数反推，不信 BFS 里累加的 t（"起点到终点直线"时两者对不上）
            return new LlkPath(pts, pts.Count - 2);
        }

        var deque = new LinkedList<int>();

        for (var d = 0; d < 4; d++)
        {
            var nr = r1 + Dr[d];
            var nc = c1 + Dc[d];
            if (OutOfRange(nr, nc)) continue;
            if (nr == r2 && nc == c2) return new LlkPath(new[] { (r1, c1), (r2, c2) }, 0);   // 紧贴：0 拐
            if (Blocked(nr, nc)) continue;

            var si = StateIndex(nr, nc, d);
            if (dist[si] <= 0) continue;
            dist[si] = 0;
            parent[si] = -1;
            deque.AddFirst(si);
        }

        while (deque.Count > 0)
        {
            var cur = deque.First!.Value;
            deque.RemoveFirst();

            var t = dist[cur];
            if (t == int.MaxValue) continue;               // 陈旧条目：起点 4 向之间互相覆盖时可能出现
            var (r, c) = CellOf(cur);
            var d = cur % 4;

            for (var nd = 0; nd < 4; nd++)
            {
                if (nd == (d ^ 1)) continue;               // 原地掉头：白绕一圈，不可能更优
                var nt = nd == d ? t : t + 1;
                if (nt > maxTurns) continue;

                var nr = r + Dr[nd];
                var nc = c + Dc[nd];
                if (OutOfRange(nr, nc)) continue;
                if (nr == r2 && nc == c2) return Build(cur);
                if (Blocked(nr, nc)) continue;

                var si = StateIndex(nr, nc, nd);
                if (dist[si] <= nt) continue;
                dist[si] = nt;
                parent[si] = cur;
                if (nd == d) deque.AddFirst(si);           // 0 权：插队首
                else deque.AddLast(si);                    // 1 权：排队尾
            }
        }

        return null;
    }

    /// <summary>
    /// 找一对<b>可连</b>的同号（H-015 提示按钮）。行优先确定性扫描，顺序与 <see cref="HasAnyPair"/> 一致，
    /// 所以"同一盘扫两次结果相同"（U6 钉住这条）。
    /// <para><paramref name="excludeIdx"/>：跳过<b>含该格</b>的对。玩家已选中一格时点提示，
    /// 若提示对含那一格，屏幕上会同时出现 <c>is-selected</c> 与 <c>is-hint</c>（两个 outline 抢同一属性）。</para>
    /// </summary>
    public (int R1, int C1, int R2, int C2)? FindHintPair(int? excludeIdx = null)
    {
        for (var i = 0; i < CellCount; i++)
        {
            if (_cells[i] == 0) continue;
            if (excludeIdx == i) continue;

            for (var j = i + 1; j < CellCount; j++)
            {
                if (_cells[j] != _cells[i]) continue;
                if (excludeIdx == j) continue;
                if (CanConnect(i / Cols, i % Cols, j / Cols, j % Cols))
                    return (i / Cols, i % Cols, j / Cols, j % Cols);
            }
        }

        return null;
    }

    /// <summary>
    /// 扣一次提示。<b>0 次或已通关一律返回 false 且不扣</b>（《39》§3.3）。
    /// <para>页面必须先 <see cref="FindHintPair"/> 找到对、再调这里 —— 反过来会在"死局瞬间点提示"时白扣一次。</para>
    /// </summary>
    public bool UseHint()
    {
        if (HintsLeft <= 0 || IsCleared) return false;
        HintsLeft--;
        return true;
    }

    /// <summary>消除一格（只清值，不做连通判定 —— 判定由调用方先做）。</summary>
    public bool Remove(int r, int c)
    {
        if (!InBoard(r, c)) return false;
        var i = Index(r, c);
        if (_cells[i] == 0) return false;

        _cells[i] = 0;
        RemainingCount--;
        return true;
    }

    /// <summary>盘上是否还存在任意一对可连的同号（死局判定）。</summary>
    public bool HasAnyPair()
    {
        for (var i = 0; i < CellCount; i++)
        {
            if (_cells[i] == 0) continue;
            for (var j = i + 1; j < CellCount; j++)
            {
                if (_cells[j] != _cells[i]) continue;
                if (CanConnect(i / Cols, i % Cols, j / Cols, j % Cols)) return true;
            }
        }
        return false;
    }

    /// <summary>
    /// 死局重排：只重排剩余方块，重排后必须存在可连对（上限 + 确定性兜底）。
    /// <para>剩余 2 块时必然可连（空盘任意两格 ≤2 拐），所以死局只可能出现在 ≥4 块时 ——
    /// 这条是"性质"写进单测，不是 if 分支。</para>
    /// </summary>
    public bool Reshuffle()
    {
        for (var round = 0; round < ReshuffleLimit; round++)
        {
            ShuffleRemaining();
            if (HasAnyPair()) return true;
        }

        ForcePair();
        return HasAnyPair();
    }

    // ───────────────────────── 快照 ─────────────────────────

    public LianliankanSnapshot ToSnapshot(int elapsedSec) => new()
    {
        V = LianliankanSnapshot.CurrentVersion,
        Issue = Issue,
        Cells = (int[])_cells.Clone(),
        ElapsedSec = elapsedSec,
        Hints = HintsLeft,
    };

    /// <summary>
    /// 会话恢复。闸门三道（《36》v2.0 §3.1）：
    /// ① 结构（版本 / 长度 / 值域 / 成对）；② 期号 == 今日；③ <b>不查"剩余盘可解"</b>。
    /// <para>第 ③ 条不是省事：v1.0 曾要求"剩余盘必须仍可解，否则丢档"，与"死局自动重排"自相矛盾 ——
    /// 恢复的死局档本来就会被重排救活，丢弃它等于把玩家打回第 1 关。</para>
    /// </summary>
    public static LianliankanCore? TryFrom(LianliankanSnapshot? s, int todayIssue)
    {
        if (s is null || s.V != LianliankanSnapshot.CurrentVersion) return null;
        if (s.Issue != todayIssue) return null;
        if (s.ElapsedSec < 0 || s.ElapsedSec > MaxElapsedSec) return null;

        var cells = s.Cells;
        if (cells is null || cells.Length != CellCount) return null;

        var counts = new int[FaceCount + 1];
        var remaining = 0;
        foreach (var v in cells)
        {
            if (v < 0 || v > FaceCount) return null;
            if (v == 0) continue;
            counts[v]++;
            remaining++;
        }

        // 成对闸：每种头像的剩余数必须是偶数，否则永远消不完
        for (var f = 1; f <= FaceCount; f++)
        {
            if (counts[f] % 2 != 0) return null;
        }

        // 全 0 = 已通关的盘。它满足"成对"（0 个也是偶数），但恢复出来只会立刻弹一次胜利遮罩
        // —— 与扫雷 Rejects_AlreadyWonSnapshot 同口径（胜局不写档，写了一定是坏档）。
        if (remaining == 0) return null;

        var core = new LianliankanCore(s.Issue, Rng.ForIssue(s.Issue));
        Array.Copy(cells, core._cells, CellCount);
        core.RemainingCount = remaining;
        // 旧档没有 hints 字段 ⇒ 补满；坏值（负数 / 超过上限）夹回合法区间，不让它把按钮画成负数
        core.HintsLeft = Math.Clamp(s.Hints ?? HintTotal, 0, HintTotal);
        return core;
    }

    // ───────────────────────── 今日最快（秒，越小越好） ─────────────────────────

    /// <summary>
    /// 解析本地榜。坏值（非 JSON / 期号不是今天 / <c>sec &lt; 1</c> / 超出一天）一律当"没有纪录"。
    /// <para><b>方向与 2048/Tetris 相反</b>（越小越好），照抄 <c>Score &gt; Best</c> 会静默地永不刷新 ——
    /// 同 <c>MinesweeperCore.TryParseBest</c>（《35》C-59 踩过）。</para>
    /// </summary>
    public static int? TryParseBest(string? raw, int todayIssue)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;

        LlkBestRecord? rec;
        try
        {
            rec = JsonSerializer.Deserialize<LlkBestRecord>(raw);
        }
        catch (JsonException)
        {
            return null;                      // "abc" / 半截 JSON
        }

        if (rec is null || rec.Issue != todayIssue) return null;   // 跨天残留：不显示昨天的成绩
        if (rec.Sec < 1 || rec.Sec > MaxElapsedSec) return null;
        return rec.Sec;
    }

    /// <summary>
    /// 返回<b>新的纪录值</b>，不需要刷新时返回 null。<c>相等不刷新</c>（同一份档重放不该改写纪录）。
    /// </summary>
    public static int? TryUpdateBest(int? current, int sec) =>
        sec >= 1 && (current is null || sec < current) ? sec : null;

    /// <summary>本地榜的落盘载荷。序列化只在这一处，键写错也只有一个地方要改。</summary>
    public static string BestJson(int issue, int sec) =>
        JsonSerializer.Serialize(new LlkBestRecord { Issue = issue, Sec = sec });

    // ───────────────────────── 确定性随机源 ─────────────────────────

    /// <summary>
    /// SplitMix64（40 行、零依赖）。<b>不用 <c>System.Random(seed)</c></b>：它的序列只有"事实稳定"，
    /// 换 .NET 大版本可能变，而那会让"同一期号的盘面"跟着变（《36》v2.0 §0 #9）。
    /// </summary>
    private sealed class Rng
    {
        private ulong _state;

        internal Rng(ulong seed) => _state = seed;

        /// <summary>用一个常量偏移把期号散开：issue 相邻（20261112 / 20261113）的盘面不该只差一点点。</summary>
        internal static Rng ForIssue(int issue) =>
            new(unchecked((ulong)(uint)issue * 0x9E3779B97F4A7C15UL) ^ 0x5DEECE66DUL);

        internal ulong NextUInt64()
        {
            unchecked
            {
                _state += 0x9E3779B97F4A7C15UL;
                var z = _state;
                z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
                z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
                return z ^ (z >> 31);
            }
        }

        /// <summary>无偏取模（拒绝采样）：直接 <c>% max</c> 会让小值概率略高。</summary>
        internal int Next(int maxExclusive)
        {
            if (maxExclusive <= 0) throw new ArgumentOutOfRangeException(nameof(maxExclusive));

            var bound = (ulong)maxExclusive;
            var rem = (ulong.MaxValue % bound + 1) % bound;   // 2^64 mod bound
            var limit = ulong.MaxValue - rem;                 // 接受 r ≤ limit

            ulong r;
            do
            {
                r = NextUInt64();
            }
            while (r > limit);

            return (int)(r % bound);
        }
    }
}
