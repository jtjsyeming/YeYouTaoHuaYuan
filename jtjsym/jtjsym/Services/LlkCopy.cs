namespace jtjsym.Services;

/// <summary>
/// 连连看的界面文案（《36》v2.1 §3.5）。
/// <para><b>期号文案只在这里拼一次</b>：页面标题、首页副行都调 <see cref="IssueLabel"/>，
/// 其余文案（遮罩、飘字、<c>title</c>）一律不带期号 —— 散着写就会出现"标题写地球日、遮罩写第 N 期"
/// 这种同一屏两种说法。要改格式（比如"今日第 N 关"）只改本文件。</para>
/// </summary>
public static class LlkCopy
{
    /// <summary>期号前缀。<b>改这一行 = 改全站说法</b>（v2.1 §0 的 ⚠ 就是问这个字面量）。</summary>
    public const string IssueLabelPrefix = "地球日";

    /// <summary>「地球日20261112关」。</summary>
    public static string IssueLabel(int issue) => $"{IssueLabelPrefix}{issue}关";

    /// <summary>恢复提示。与扫雷同款语气：先说"已恢复"，再说"怎么继续"。</summary>
    public const string ResumeTip = "已恢复上一局（计时已暂停，点棋盘继续）";

    /// <summary>死局重排飘字。</summary>
    public const string ReshuffleTip = "无解自动重排";

    /// <summary>同脸但拐不过去（>2 拐）。10 字，320px 下单行。</summary>
    public const string NotConnectable = "连不上：最多拐两次弯";

    /// <summary>
    /// ④ 层：同脸但<b>完全没路</b>（无限拐也不通）。
    /// <para>独立成句、不复用 <see cref="NotConnectable"/>：那句话讲的是"拐数不够"，
    /// 而这一层根本无路可走 —— 再讲"最多两次"就不准确了（《39》§2.1 拍板 1）。7 字，320 下远小于单行上限。</para>
    /// <para>⚠ 两句都含「连不上」，所以 LL-18 必须<b>整句匹配</b>，包含匹配分不出这两层。</para>
    /// </summary>
    public const string NoRoute = "这两张连不上";

    /// <summary>状态行里的提示按钮。次数由 Core 给，页面不自己减。</summary>
    public static string HintButton(int left) => $"提示 {left}";

    /// <summary>「图案不同」的裸文案：角色名取不到（编号越界）时退化用它，不拼空名。</summary>
    public const string DifferentFacesBare = "图案不同";

    /// <summary>
    /// 点了两张不同的脸（D-30 的失败反馈）。
    /// <para>带角色名是刻意的：新手最常犯的错就是"以为长得像就是一对"，把两个名字并排说出来，
    /// 比只说"图案不同"有用。名字本来就已在格子的 <c>aria-label</c> 里，不构成新暴露。</para>
    /// <para>最长一条是「图案不同：英国公夫人 ≠ 魏老夫人」= 17 字，实测 320px 下仍单行（213px / 容器 272px）。
    /// <b>这条文案的长度是一等约束</b>：超过约 18 字会在 320 下折成两行，而 LL-11 打开的是干净页面、看不见提示行。</para>
    /// </summary>
    public static string DifferentFaces(int a, int b)
    {
        var na = LianliankanThemes.ById(a)?.Name;
        var nb = LianliankanThemes.ById(b)?.Name;
        return string.IsNullOrEmpty(na) || string.IsNullOrEmpty(nb)
            ? DifferentFacesBare
            : $"{DifferentFacesBare}：{na} ≠ {nb}";
    }

    /// <summary>无纪录时的占位（对齐 2048/扫雷的「—」，不是「0 秒」）。</summary>
    public const string NoRecord = "—";

    // ───────────────────────── 玩法遮罩（H-015，首访一次） ─────────────────────────
    // 四行文案也收在这里：遮罩与提示行讲的是同一套视觉语法（虚线 = 走不通），
    // 分头写就会出现"画的是虚线、文案说走不通的线"（《39》§2.2 末条）。

    /// <summary>遮罩标题。</summary>
    public const string RulesTitle = "怎么玩";

    /// <summary>第 1 行：目标。</summary>
    public const string RulePair = "· 点两个相同的图案";

    /// <summary>第 2 行：连通口径。</summary>
    public const string RuleTurns = "· 连线最多拐两次弯";

    /// <summary>第 3 行：③ 层的画法（虚线已成为视觉语法的一部分，文案不跟着说会和画面打架）。</summary>
    public const string RuleHintLine = "· 连不上会画出虚线，并高亮拐弯处";

    /// <summary>第 4 行：提示次数。</summary>
    public const string RuleHints = "· 卡住了点「提示」，每局三次";

    /// <summary>遮罩按钮。</summary>
    public const string RulesStart = "开始";

    /// <summary>首页副行：有纪录。</summary>
    public static string HomeWithBest(int issue, int sec) => $"{IssueLabel(issue)} · 你的最快 {sec} 秒";

    /// <summary>首页副行：无纪录。</summary>
    public static string HomeNoBest(int issue) => $"{IssueLabel(issue)} · 今日还没通关";
}
