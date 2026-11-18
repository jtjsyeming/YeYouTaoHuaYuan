using System;
using System.Linq;
using jtjsym.Services;
using Xunit;

namespace jtjsym.Tests;

/// <summary>
/// 兜底字牌文案（H-016 / D-33，U8）。
/// <para><b>为什么值得单测</b>：这两字只在"图没画出来"时才出现在玩家眼前，而那正是最需要
/// "还能分清谁是谁"的时刻。表一旦与 <see cref="LianliankanThemes.Characters"/> 脱钩，
/// 正常运行、所有 e2e 全绿也发现不了 —— 只有真机上没图时才暴露（《44》§0 E1 的教训）。
/// 所以在纯函数层把它钉死。</para>
/// </summary>
public class LlkCopyTests
{
    private const int FaceCount = 24;

    /// <summary>
    /// U8：24 项两两不同 + 每项是对应角色名的连续子串 + 越界给 "??"。
    /// <para>三条合一条 Fact 是刻意的：它们看守的是同一个不变式（"牌面能指认出人"），
    /// 分开反而会出现"唯一性绿、子串红"这种半绿状态被当成通过。</para>
    /// </summary>
    [Fact]
    public void ShortName_UniqueAndSubstring()
    {
        Assert.Equal(FaceCount, LianliankanThemes.Characters.Length);

        var shorts = Enumerable.Range(1, FaceCount).Select(LlkCopy.ShortName).ToArray();

        // ① 两两不同（且都是两个字：塌成 1 字或胀成 3 字会改牌面排版）
        Assert.Equal(FaceCount, shorts.Distinct().Count());
        Assert.All(shorts, s => Assert.Equal(2, s.Length));

        // ② 每项是对应 Name 的连续子串 —— 只判唯一性的话，改名后旧表依然"唯一"却已指错人
        for (var face = 1; face <= FaceCount; face++)
        {
            var name = LianliankanThemes.ById(face)!.Name;
            var shortName = LlkCopy.ShortName(face);
            Assert.True(
                name.Contains(shortName, StringComparison.Ordinal),
                $"face={face}：字牌「{shortName}」不是角色名「{name}」的连续子串");
        }

        // ③ 越界给 "??"：保持两字宽（空串会让牌面塌成一条缝），且不抛异常（渲染路径不该因数据越界炸掉）
        Assert.Equal("??", LlkCopy.ShortName(0));
        Assert.Equal("??", LlkCopy.ShortName(-1));
        Assert.Equal("??", LlkCopy.ShortName(FaceCount + 1));
    }

    /// <summary>
    /// U12：24 条字牌 SVG data-URI（D-39 / P2）。
    /// <para><b>为什么值得单测</b>：这条 data-URI 是"图没画出来时还能不能玩"的最后一层，
    /// 而它一旦出错，症状是**静默的** —— 页面上只是"格子还是纯平色块"，与"图真的没画"长得一模一样。
    /// 三条东西不靠测就守不住：① 里面确实是这一格的两个人名；② 值是 URL 安全的（见下）；
    /// ③ 24 条两两不同（同名会让两格长得一样，降级态直接无法辨认）。</para>
    /// <para><b>URL 安全为什么是硬约束</b>：这段 CSS 由 Razor 的 MarkupString 插进样式块，
    /// Blazor 写 markup 帧时交给 HTML 解析器 —— 裸的尖括号会被解析成标签、在样式块里不参与文本，
    /// 于是整条 SVG 被吞掉、只剩两个人名（本轮实测）。<c>#</c> 则是另一种半残：它起 fragment，
    /// 后面的内容全丢（"底色有、字没有"）。整条 <see cref="Uri.EscapeDataString"/> 之后两者都没了，
    /// 这里就把"值里不许有裸 <c>&lt;</c> / <c>#</c> / 空格 / 引号"钉成断言。</para>
    /// </summary>
    [Fact]
    public void FaceTileDataUri_UniqueUrlSafeAndCarriesName()
    {
        var uris = Enumerable.Range(1, FaceCount).Select(LlkCopy.FaceTileDataUri).ToArray();

        // ① 24 条两两不同
        Assert.Equal(FaceCount, uris.Distinct().Count());

        foreach (var face in Enumerable.Range(1, FaceCount))
        {
            var uri = LlkCopy.FaceTileDataUri(face);
            var inner = uri[5..^2];      // 去掉 url(" 与 ") —— 判的是"URL 本身"，不是外面的包装

            // ② URL 安全：这四类字符原样出现就是 bug，不是风格问题
            Assert.DoesNotContain('<', inner);
            Assert.DoesNotContain('>', inner);
            Assert.DoesNotContain('#', inner);
            Assert.DoesNotContain('"', inner);
            Assert.DoesNotContain(" ", inner);

            // ③ 里面确实是这一格的字与族色（编码后比较：中文会被转成 %XX）
            Assert.Contains(Uri.EscapeDataString(LlkCopy.ShortName(face)), inner);
            Assert.Contains(Uri.EscapeDataString(LianliankanThemes.ById(face)!.Accent), inner);

            // ④ 固定配色与长度上限：改回内联 48 格或塞 PNG base64 都会让这条先炸
            Assert.Contains("%23F3ECE1", inner);   // 米纸底
            Assert.Contains("%232B2B2B", inner);   // 深字（12.07:1）
            Assert.InRange(uri.Length, 300, 700);
        }

        // ⑤ 越界给 none —— 与 CSS 的 var(--fb, none) 同形，让"这格没有字牌"也走同一条声明
        Assert.Equal("none", LlkCopy.FaceTileDataUri(0));
        Assert.Equal("none", LlkCopy.FaceTileDataUri(-1));
        Assert.Equal("none", LlkCopy.FaceTileDataUri(FaceCount + 1));
    }

    /// <summary>
    /// U12 续：拼出来的样式片段每条一个 <c>.llk-face-N</c>，且总长度在预算内。
    /// <para>总长度上限是防"有人把 24 条改成 48 格内联"或"把 PNG base64 塞进来"——
    /// 那种改动在功能上可能没坏，但会让预渲染 HTML 凭空多几十 KB（每格都要带一份）。</para>
    /// </summary>
    [Fact]
    public void FaceFallbackCss_OneRulePerFace()
    {
        var css = LlkCopy.FaceFallbackCss();
        var lines = css.Split('\n');

        Assert.Equal(FaceCount, lines.Length);
        for (var face = 1; face <= FaceCount; face++)
        {
            var prefix = $".llk-face-{face}{{--fb:url(\"data:image/svg+xml,";
            Assert.StartsWith(prefix, lines[face - 1]);
        }

        Assert.InRange(css.Length, 8_000, 16_000);

        // memo：同一个实例（每帧都会调它，页面每秒都有一次计时重渲染）
        Assert.Same(css, LlkCopy.FaceFallbackCss());
    }
}
