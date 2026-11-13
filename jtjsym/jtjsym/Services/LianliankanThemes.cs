namespace jtjsym.Services;

/// <summary>
/// 一个格面角色（《36》v2.1 §1）。
/// <para>只保留"渲染与无障碍需要"的四项：编号（对应 sprite 的格位）、姓名（只进 <c>aria-label</c>）、
/// 色族（同一行 6 人同族，用于将来换皮时按族替换）、主色（文档与验收用，页面不读它 ——
/// 颜色已经在图里了，再写进 DOM 只会让"图挂了"和"配色错了"两种故障长得一样）。</para>
/// </summary>
public sealed class LlkCharacter
{
    public LlkCharacter(int id, string name, string family, string accent)
    {
        Id = id;
        Name = name;
        Family = family;
        Accent = accent;
    }

    /// <summary>1..24，同时是 <c>data-face</c> 的值与 sprite 的格位索引。</summary>
    public int Id { get; }

    /// <summary>角色名。<b>只出现在 <c>aria-label</c> 与文档里</b>，格面上不显示文字（v2.1 §2.5）。</summary>
    public string Name { get; }

    /// <summary>色族：朱砂 / 石青 / 玄墨 / 藕荷 / 秋香 / 月白（6 族 × 4 人）。</summary>
    public string Family { get; }

    /// <summary>主色（#RRGGBB）。换皮时按族内替换，算法与键名都不动。</summary>
    public string Accent { get; }
}

/// <summary>
/// 24 个格面角色 + sprite 定位（《36》v2.1 §1 / §2.2）。
/// <para><b>选角口径是"40px 下能认出来"</b>，不是番位：主色 6 族 × 每组 4 人，
/// 同族 4 人靠头饰形状（剪影）区分 —— 40px 下颜色只有 6 档可辨，同色必须靠轮廓。</para>
/// <para>编号与 <c>Images/llk/faces.png</c> 的格位一一对应（6 列 × 4 行，行优先），
/// 改名/换人只动这个数组，<b>不动算法、不动存储键</b>。</para>
/// </summary>
public static class LianliankanThemes
{
    /// <summary>sprite 的列数。</summary>
    public const int Columns = 6;

    /// <summary>sprite 的行数（24 / 6）。</summary>
    public const int Rows = 4;

    /// <summary>24 个角色，下标 = <c>Id - 1</c>。</summary>
    public static readonly LlkCharacter[] Characters =
    {
        new(1, "魏娆", "朱砂", "#B3423C"),
        new(2, "君黛", "朱砂", "#C8463F"),
        new(3, "魏姝", "朱砂", "#9E2B2B"),
        new(4, "谢画楼", "朱砂", "#C05C57"),
        new(5, "陆濯", "石青", "#3D5A80"),
        new(6, "霍玦", "石青", "#4A6B8A"),
        new(7, "刘狩", "石青", "#2F4A6B"),
        new(8, "润生", "石青", "#5D7A96"),
        new(9, "戚仲恺", "玄墨", "#2B2B2B"),
        new(10, "韩辽", "玄墨", "#1F1F1F"),
        new(11, "戎王", "玄墨", "#4A3B2F"),
        new(12, "陆秋", "玄墨", "#3A3A3A"),
        new(13, "周芙", "藕荷", "#B98BA8"),
        new(14, "魏恒娥", "藕荷", "#9C7A96"),
        new(15, "郭虞凤", "藕荷", "#A8859E"),
        new(16, "孔瑛书", "藕荷", "#C0A0B8"),
        new(17, "碧桃", "秋香", "#C9A227"),
        new(18, "阿蛮", "秋香", "#D2B345"),
        new(19, "红线", "秋香", "#B98F1F"),
        new(20, "贺婉娘", "秋香", "#D8C070"),
        new(21, "魏老夫人", "月白", "#8C8F96"),
        new(22, "英国公夫人", "月白", "#7E858E"),
        new(23, "太后", "月白", "#6F7A85"),
        new(24, "郑婕妤", "月白", "#9AA3AC"),
    };

    /// <summary>按编号取角色；越界返回 null（页面对 0 格不取角色）。</summary>
    public static LlkCharacter? ById(int id) =>
        id >= 1 && id <= Characters.Length ? Characters[id - 1] : null;

    /// <summary>
    /// sprite 格位：<c>idx</c> 1..24 → <c>col = (idx-1) % 6</c>、<c>row = ⌊(idx-1)/6⌋</c>。
    /// <para>不留额外映射文件：这一条公式就是全部映射，页面把结果写进 <c>--c</c>/<c>--r</c>，
    /// CSS 用 <c>background-position</c> 算偏移，<b>预渲染阶段就能算好、不需要 JS 参与</b>。</para>
    /// </summary>
    public static (int Col, int Row) Position(int id)
    {
        var i = id - 1;
        return (i % Columns, i / Columns);
    }
}
