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

    /// <summary>无纪录时的占位（对齐 2048/扫雷的「—」，不是「0 秒」）。</summary>
    public const string NoRecord = "—";

    /// <summary>首页副行：有纪录。</summary>
    public static string HomeWithBest(int issue, int sec) => $"{IssueLabel(issue)} · 你的最快 {sec} 秒";

    /// <summary>首页副行：无纪录。</summary>
    public static string HomeNoBest(int issue) => $"{IssueLabel(issue)} · 今日还没通关";
}
