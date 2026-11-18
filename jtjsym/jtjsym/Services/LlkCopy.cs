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

    // ───────────────────────── 兜底字牌（H-016 / D-33） ─────────────────────────
    // "图挂了"时格面上不再有图案，只剩这两字。**不用 Name[..2] 截断**：
    // 那会把「英国公夫人」截成「英国」—— 根本不是一个角色（而「谢画楼」截成「谢画」只是别扭）。

    /// <summary>兜底字牌的两字标（H-016）。下标 = face - 1；越界返回 "??"（保持两字宽，不塌格）。</summary>
    /// <remarks>
    /// 两条硬约束，由 U8（<c>LlkCopyTests.ShortName_UniqueAndSubstring</c>）看守，<b>不靠"记得改"</b>：
    /// ① 24 项两两不同 —— 字牌是降级态唯一的身份线索；
    /// ② 每项都是 <see cref="LianliankanThemes.Characters"/> 里 <c>Name</c> 的<b>连续子串</b> ——
    /// 只判唯一性的话，改名后旧表依然"唯一"却已经指错人。
    /// </remarks>
    private static readonly string[] ShortNames =
    {
        "魏娆", "君黛", "魏姝", "画楼", "陆濯", "霍玦", "刘狩", "润生",
        "仲恺", "韩辽", "戎王", "陆秋", "周芙", "恒娥", "虞凤", "瑛书",
        "碧桃", "阿蛮", "红线", "婉娘", "魏老", "国公", "太后", "婕妤",
    };

    /// <summary>兜底字牌文案：<paramref name="face"/> ⇒ 两字标（H-016）。越界给 <c>"??"</c>。</summary>
    public static string ShortName(int face) =>
        face >= 1 && face <= ShortNames.Length ? ShortNames[face - 1] : "??";

    // ───────────────────── 兜底字牌的图化（D-39） ─────────────────────
    // 为什么要把它做成**图**而不是 HTML 文本：自动暗化（Android Auto Dark / 桌面 --force-dark-mode）
    // 只反转**文本与被指定的背景色**，图片像素一律不动（实测：sprite 与 SVG data-URI 在暗化下保持原色）。
    // 文本版字牌被反成深底深字就整块看不见 —— 那正是 D-39 第三轮报上来的现场。
    // 图化之后"看得见"不再依赖暗化是否退出，也不依赖任何检测链：字牌图作为 `background-image` 的**第二层**，
    // 第一层 sprite 因任何原因不画（404 / 被拦 / 解码失败 / 老内核丢弃）时它自动露出，零 JS。

    /// <summary>
    /// 兜底字牌的 SVG <c>data-URI</c>（D-39 / P2）；编号越界返回 <c>none</c>。
    /// </summary>
    /// <remarks>
    /// 四条硬约束，改动前先看：
    /// <para>① <b>整条 SVG 必须 <see cref="Uri.EscapeDataString"/> 百分号编码，不能原样塞进去。</b>
    /// 这条是本轮实测出来的硬约束（方案原文给的是"只把 <c>#</c> 编码成 <c>%23</c>"，实测不够）：
    /// 这段 CSS 由 Razor 的 <c>MarkupString</c> 插进组件的样式块，而 Blazor 写 markup 帧时是交给
    /// <b>HTML 解析器</b>的 —— SVG 里的裸 <c>&lt;svg&gt;</c> 会被当成标签解析成元素，元素在样式块里
    /// 不参与文本，于是 CSS 里只剩 <c>url("data:image/svg+xml;utf8,婉娘")</c>：标签全丢、字也不按图渲染。
    /// 整条编码之后值里只有 URL 安全字符，同时把 <c>#</c>、引号、空格一起解决掉。</para>
    /// <para>② 越界给 <c>none</c> 而不是空串：CSS 里 <c>var(--fb)</c> 缺失会让<b>整条</b> <c>background-image</c>
    /// 计算成 <c>none</c> —— 连第一层 sprite 一起没（实测）。给字面量 <c>none</c> 才能让"这格没有字牌"
    /// 与"这格有字牌"共用同一条叠层声明。</para>
    /// <para>③ 配色与 <c>.llk-face-fb</c> 的 CSS 同值（<c>#F3ECE1</c> 底 + <c>#2B2B2B</c> 字 = 12.07:1），
    /// 族色只做左侧 4px 竖条 —— 14/24 个 Accent 与白字的对比度不足 4.5，底色不能跟着族色走。</para>
    /// <para>④ 颜色写<b>裸</b> <c>#RRGGBB</c>，靠编码器转成 <c>%23</c>。别手写 <c>%23</c>：
    /// 手写过一次以后谁都分不清"这段编码过没有"，而漏编码的症状是"底色有、字没有"。</para>
    /// </remarks>
    public static string FaceTileDataUri(int face)
    {
        var t = LianliankanThemes.ById(face);
        if (t is null) return "none";

        var accent = string.IsNullOrEmpty(t.Accent) ? "#8C8F96" : t.Accent;
        var svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>"
            + "<rect width='64' height='64' fill='#F3ECE1'/>"
            + $"<rect width='4' height='64' fill='{accent}'/>"
            + "<text x='36' y='41' font-family='sans-serif' font-size='17' text-anchor='middle' fill='#2B2B2B'>"
            + ShortName(face) + "</text></svg>";
        return $"url(\"data:image/svg+xml,{Uri.EscapeDataString(svg)}\")";
    }

    /// <summary>
    /// 24 条 <c>.llk-face-N { --fb: … }</c> 的 CSS 片段（D-39 / P2），渲进组件的样式块。
    /// </summary>
    /// <remarks>
    /// <para><b>为什么由 C# 生成、不写死在 <c>site.css</c></b>：写死等于把 24 个人名复制出第二份真源，
    /// 而 <see cref="ShortName"/> 那份已有 U8 看守（唯一 + 是角色名的连续子串）。</para>
    /// <para><b>为什么 memo 住</b>：这个片段会被渲进每帧的样式块，而连连看页面<b>每秒</b>都有一次计时
    /// 重渲染 —— 不缓存就是每秒重拼 24 条 data-URI。</para>
    /// <para>体积：单条约 <b>480 B</b>、24 条约 <b>11.5 KB</b>（未 gzip），仍比 24 张 PNG（≈100 KB）省一个量级。</para>
    /// </remarks>
    public static string FaceFallbackCss() => FallbackCss.Value;

    private static readonly Lazy<string> FallbackCss = new(BuildFallbackCss);

    private static string BuildFallbackCss() =>
        string.Join('\n', Enumerable.Range(1, LianliankanThemes.Characters.Length)
            .Where(f => LianliankanThemes.ById(f) is not null)   // id 不连续时跳过，不抛
            .Select(f => $".llk-face-{f}{{--fb:{FaceTileDataUri(f)}}}"));

    /// <summary>首页副行：有纪录。</summary>
    public static string HomeWithBest(int issue, int sec) => $"{IssueLabel(issue)} · 你的最快 {sec} 秒";

    /// <summary>首页副行：无纪录。</summary>
    public static string HomeNoBest(int issue) => $"{IssueLabel(issue)} · 今日还没通关";
}
