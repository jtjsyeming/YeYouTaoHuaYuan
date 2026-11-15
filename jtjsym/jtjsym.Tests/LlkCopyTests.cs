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
}
