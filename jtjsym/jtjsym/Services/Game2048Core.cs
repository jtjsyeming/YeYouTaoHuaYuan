namespace jtjsym.Services;

/// <summary>
/// 2048 的纯逻辑内核（《26》H-008 / 《05》§6.2）。刻意保持**线粒度**：
/// 棋盘仍是组件内的 <c>int[,]</c>，由 <c>GetRow/SetRow/GetColumn/SetColumn</c> 隔成"一条线"再进来，
/// 所以抽离只搬算法、不动棋盘形状（改形状会连带 D-16/D-17 的存档代码，收益为负、风险为正）。
/// <para>本类不依赖任何 UI / 组件状态：输入只有数组，输出只有数组与 <c>ref score</c>，
/// 因此可被 <c>jtjsym.Tests</c> 直接断言。改这里的算法前先看《07》§6.2 的 G2048-07~18。</para>
/// </summary>
public static class Game2048Core
{
    /// <summary>标准 2048：90% 出 2、10% 出 4（D-01 常量随迁；改它要同步《07》G2048-01 的口径）。</summary>
    public const int FourSpawnPercent = 10;

    /// <summary>
    /// 压缩 → 成对消费 → 尾补零。score 走 <c>ref</c> 累加，与原 <c>Merge</c> 的语义逐字一致
    /// （合并即加分，未合并不加分；<c>i += 2</c> 保证合并出的新块不参与本步再合并）。
    /// </summary>
    public static int[] Merge(int[] line, ref int score)
    {
        ArgumentNullException.ThrowIfNull(line);

        // Step1: 压缩 —— 取出所有非零块，保持相对顺序
        var values = new List<int>(line.Length);
        foreach (var v in line)
        {
            if (v != 0) values.Add(v);
        }

        // Step2: 从移动方向一侧起成对消费，等值即合并
        var merged = new List<int>(line.Length);
        int i = 0;
        while (i < values.Count)
        {
            if (i + 1 < values.Count && values[i] == values[i + 1])
            {
                merged.Add(values[i] * 2);
                score += values[i] * 2;
                i += 2;   // 两个块同时消费 —— 不复制、不回看
            }
            else
            {
                merged.Add(values[i]);
                i += 1;
            }
        }

        // Step3: 尾部补零
        while (merged.Count < line.Length)
        {
            merged.Add(0);
        }

        return merged.ToArray();
    }

    /// <summary>
    /// 无空格、且上下左右都没有同值邻居时才判死。棋盘以**行主序**扁平 <c>size × size</c> 传入
    /// （<c>[0,0],[0,1]…</c>，与存档的 <c>i / GridSize, i % GridSize</c> 同序，不会转置）。
    /// </summary>
    public static bool IsGameOver(int[] flat, int size = 4)
    {
        ArgumentNullException.ThrowIfNull(flat);
        if (size < 1) throw new ArgumentOutOfRangeException(nameof(size), size, "棋盘边长必须 ≥ 1");
        if (flat.Length != size * size)
            throw new ArgumentException($"棋盘必须是 {size}×{size} = {size * size} 格，实际传入 {flat.Length} 格", nameof(flat));

        for (int i = 0; i < flat.Length; i++)
        {
            if (flat[i] == 0) return false;   // 还有空位 = 还能动
        }

        for (int row = 0; row < size; row++)
        {
            for (int col = 0; col < size; col++)
            {
                int v = flat[row * size + col];
                if (col + 1 < size && v == flat[row * size + col + 1]) return false;
                if (row + 1 < size && v == flat[(row + 1) * size + col]) return false;
            }
        }

        return true;
    }

    /// <summary>
    /// 新块的取值：<c>Next(100) ∈ [0,100)</c>，<c>&lt; 100 − fourPercent</c> 覆盖 90 个值 ⇒ 出 2 的概率恰 90%。
    /// <para>rng 由调用方注入（组件传自己的 <c>Random</c> 字段），单测可传固定种子的实例做比例区间断言。</para>
    /// </summary>
    public static int SpawnValue(Random rng, int fourPercent = FourSpawnPercent)
    {
        ArgumentNullException.ThrowIfNull(rng);
        if (fourPercent is < 0 or > 100) throw new ArgumentOutOfRangeException(nameof(fourPercent), fourPercent, "必须在 0~100 之间");
        return rng.Next(100) < 100 - fourPercent ? 2 : 4;
    }
}
