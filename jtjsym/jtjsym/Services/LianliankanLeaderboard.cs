using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace jtjsym.Services;

/// <summary>
/// 一条榜单记录（H-018）。<see cref="Sec"/> 是通关用时（秒，<b>小者优</b>）。
/// <para><see cref="Ts"/> 只做人工排查用 —— <b>不参与任何判断</b>：不按它排序、不按它失效、不进任何断言。
/// 唯一目的就是"这个数字是什么时候写进来的"在翻文件时能看一眼。</para>
/// </summary>
public sealed record LlkRecord(int Sec, string Name, string Ts);

/// <summary>
/// 连连看每日榜（H-018）：进程内单例 + 单文件 JSON + 懒加载缓存 + 原子写。
/// </summary>
/// <remarks>
/// <para><b>为什么是单文件而不是"每期一文件"</b>（36 号 §3.3' 原案是后者）：日历页是<b>区间查询</b>
/// —— 一次要整月的纪录，每期一文件要么读 30 次、要么另外维护一份索引；单文件把锁也收敛到一处，
/// 年量 = 365 条、不到 1 KB。代价必须写明：<b>单文件损坏 = 全榜丢失</b>，靠
/// "坏档 ⇒ 空榜不抛 + 下一次提交正常写回即自愈"兜住（U13-3 看守）。</para>
/// <para><b>读路径绝不写盘</b>：文件/目录不存在就返回空，<b>不建目录、不建文件</b>。
/// 这条不是洁癖 —— "首次启动自动建空榜"会让日历页在预渲染里产生副作用，
/// 而 <c>ServerPrerendered</c> 每次请求都跑两遍（U13-6 是它的守卫）。只有 <see cref="SubmitAsync"/> 才写。</para>
/// <para><b>写路径每次重建目录</b>：e2e 的 <c>beforeAll</c> 会删数据目录，而服务进程还活着
/// （<c>reuseExistingServer: true</c>），只在构造时建一次 ⇒ 提交抛 <c>DirectoryNotFoundException</c>
/// ⇒ 被"提交失败静默"吞掉 ⇒ 得到一条查不出原因的假红。</para>
/// </remarks>
public sealed class LianliankanLeaderboard
{
    /// <summary>榜单文件名。文档与发布验收都按这个名字找，改它要同步《现状》与验收清单。</summary>
    public const string FileName = "llk-records.json";

    /// <summary>昵称最大长度（UTF-16 文本元素，不是 <c>char</c>）。与页面 <c>maxlength</c> 同值。</summary>
    public const int MaxNameLength = 12;

    /// <summary>北京时间固定偏移（与 <see cref="LianliankanCore.IssueFor"/> 同口径，不查系统时区）。</summary>
    private static readonly TimeSpan BeijingOffset = TimeSpan.FromHours(8);

    /// <summary>
    /// 落盘序列化选项。
    /// <para><b><c>UnsafeRelaxedJsonEscaping</c> 是刻意的</b>：默认编码器会把中文转成 <c>\u6D4B</c>、
    /// 把 <c>+08:00</c> 转成 <c>\u002B08:00</c>。这份文件的作用之一就是"人工打开看一眼"，
    /// 全转义之后它既读不出名字、也认不出时区。这里只写 JSON 文件、不进 HTML，不涉及 XSS 面。</para>
    /// </summary>
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        WriteIndented = false,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly string _dir;

    /// <summary>串行化闸。<c>SemaphoreSlim</c> 而不是 <c>lock</c>：文件 IO 是异步的，且不许压 circuit 线程。</summary>
    private readonly SemaphoreSlim _gate = new(1, 1);

    /// <summary>进程内缓存。懒加载一次，写后整体替换。<c>null</c> = 还没读过。</summary>
    private Dictionary<int, LlkRecord>? _cache;

    /// <summary>
    /// 构造<b>只算路径、不读盘</b>：启动时的 IO 失败不能让站点起不来。
    /// </summary>
    public LianliankanLeaderboard(IConfiguration cfg)
    {
        var configured = cfg["Lianliankan:DataDir"];
        _dir = Path.GetFullPath(string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(AppContext.BaseDirectory, "..", "llk-data")   // 发布目录的**兄弟**目录：robocopy /MIR 碰不到
            : configured);
    }

    /// <summary>数据目录（绝对路径）。给测试与发布验收用。</summary>
    public string DataDir => _dir;

    private string FilePath => Path.Combine(_dir, FileName);

    // ───────────────────────── 读 ─────────────────────────

    /// <summary>单期纪录；没有就 <c>null</c>。<b>不写盘</b>。</summary>
    public async Task<LlkRecord?> GetAsync(int issue, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var map = await LoadAsync(ct);
            return map.TryGetValue(issue, out var rec) ? rec : null;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// 区间纪录（<b>两端都含</b>）。返回的是<b>副本</b>：调用方拿不到缓存本身，改它也不会污染服务。
    /// </summary>
    public async Task<IReadOnlyDictionary<int, LlkRecord>> GetRangeAsync(int fromIssue, int toIssue, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var map = await LoadAsync(ct);
            var slice = new Dictionary<int, LlkRecord>();
            foreach (var (issue, rec) in map)
            {
                if (issue >= fromIssue && issue <= toIssue) slice[issue] = rec;
            }
            return slice;
        }
        finally
        {
            _gate.Release();
        }
    }

    // ───────────────────────── 写 ─────────────────────────

    /// <summary>
    /// 提交一次成绩。返回<b>实际落盘的记录</b>；<c>null</c> = 未采纳（闸拒 / 不够快）。
    /// </summary>
    /// <remarks>
    /// 两道闸：① <c>1 &lt;= sec &lt;= MaxElapsedSec</c>（对齐 <c>TryUpdateBest</c> / <c>TryParseBest</c>）；
    /// ② <c>MinIssue &lt;= issue &lt;= IssueFor(now)</c> —— 页面已经拦过未来关，但会话档是浏览器侧的、
    /// 可以伪造 issue，多一道几乎零成本的闸。
    /// <para>覆盖规则：无纪录 ⇒ 写；<b>更快</b> ⇒ 覆盖且<b>名字随之替换</b>（纪录保持者就是名字里的人）；
    /// 相等或更慢 ⇒ 不动（相等不覆盖，与 <c>TryUpdateBest</c> 同口径：同一份档重放不该改写纪录）。</para>
    /// </remarks>
    public async Task<LlkRecord?> SubmitAsync(int issue, int sec, string? name, CancellationToken ct = default)
    {
        if (sec < 1 || sec > LianliankanCore.MaxElapsedSec) return null;

        var today = LianliankanCore.IssueFor(DateTimeOffset.UtcNow);
        if (issue < LianliankanCore.MinIssue || issue > today) return null;

        await _gate.WaitAsync(ct);
        try
        {
            var map = await LoadAsync(ct);
            if (map.TryGetValue(issue, out var current) && sec >= current.Sec) return null;

            var rec = new LlkRecord(
                sec,
                NormalizeName(name),
                DateTimeOffset.UtcNow.ToOffset(BeijingOffset).ToString("yyyy-MM-dd'T'HH:mm:sszzz"));

            // 先落盘、再换缓存：写失败时缓存不能指向一个磁盘上不存在的状态
            var next = new Dictionary<int, LlkRecord>(map) { [issue] = rec };
            await SaveAsync(next, ct);
            _cache = next;
            return rec;
        }
        finally
        {
            _gate.Release();
        }
    }

    // ───────────────────────── 名字归一 ─────────────────────────

    /// <summary>
    /// 昵称归一：<c>Trim</c> → 去掉控制字符（含 <c>\r\n\t</c>）→ 空则「神秘嘉宾」→ 截 12 个文本元素。
    /// </summary>
    /// <remarks>
    /// <b>按文本元素截断，不按 <c>char</c></b>：emoji 占两个 <c>char</c>，
    /// <c>s[..12]</c> 会把代理对劈成半个 —— 落盘后是一个 <c>U+FFFD</c>，而它是合法的 JSON 字符串，
    /// 于是"坏名字"会一路静默进榜。用 <see cref="LlkCopy.TrimToTextElements"/> 兜住。
    /// </remarks>
    public static string NormalizeName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return LlkCopy.GuestName;

        var sb = new System.Text.StringBuilder(name.Length);
        foreach (var ch in name)
        {
            // 控制字符（\r \n \t 以及其余 C0/C1）会让一行名字在详情条里断成两行，直接不要
            if (char.IsControl(ch)) continue;
            sb.Append(ch);
        }

        var cleaned = sb.ToString().Trim();
        return cleaned.Length == 0 ? LlkCopy.GuestName : LlkCopy.TrimToTextElements(cleaned, MaxNameLength);
    }

    // ───────────────────────── 存取 ─────────────────────────

    /// <summary>
    /// 懒加载整份榜。文件不存在 ⇒ 空表（<b>绝不建目录/建文件</b>）。
    /// 坏数据（非 JSON / 半截 JSON / 顶层不是对象 / 键不是数字）⇒ 空表、不抛、<b>不删文件</b>。
    /// </summary>
    private async Task<Dictionary<int, LlkRecord>> LoadAsync(CancellationToken ct)
    {
        if (_cache is not null) return _cache;

        var map = new Dictionary<int, LlkRecord>();

        if (File.Exists(FilePath))
        {
            try
            {
                var json = await File.ReadAllTextAsync(FilePath, ct);
                var raw = JsonSerializer.Deserialize<Dictionary<int, LlkFileRecord>>(json);
                if (raw is not null)
                {
                    foreach (var (issue, rec) in raw)
                    {
                        // 逐条过值域闸：手改坏一条不该让整份榜作废（但整份解析失败照样回空，见 catch）
                        if (rec is null) continue;
                        if (rec.Sec < 1 || rec.Sec > LianliankanCore.MaxElapsedSec) continue;
                        if (issue < LianliankanCore.MinIssue) continue;
                        map[issue] = new LlkRecord(rec.Sec, NormalizeName(rec.Name), rec.Ts ?? string.Empty);
                    }
                }
            }
            catch (JsonException) { }                     // 非 JSON / 半截 / 顶层是数组
            catch (IOException) { }                       // 被独占 / 网络盘掉线
            catch (UnauthorizedAccessException) { }       // 权限
        }

        _cache = map;
        return map;
    }

    /// <summary>整份替换写：建目录 → 写 <c>.tmp</c> → 同卷 rename（原子）。</summary>
    private async Task SaveAsync(Dictionary<int, LlkRecord> map, CancellationToken ct)
    {
        Directory.CreateDirectory(_dir);                  // ⚠ 每次都要：跑批中途目录会被清（见类注释）

        var payload = new Dictionary<int, LlkFileRecord>(map.Count);
        foreach (var (issue, rec) in map)
        {
            payload[issue] = new LlkFileRecord { Sec = rec.Sec, Name = rec.Name, Ts = rec.Ts };
        }

        var tmp = FilePath + ".tmp";
        await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(payload, JsonOpts), ct);
        File.Move(tmp, FilePath, overwrite: true);
    }

    /// <summary>落盘形状：<c>{"20261101":{"sec":123,"name":"阿P","ts":"2026-11-01T21:04:11+08:00"}}</c>。</summary>
    private sealed class LlkFileRecord
    {
        [JsonPropertyName("sec")] public int Sec { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("ts")] public string? Ts { get; set; }
    }
}
