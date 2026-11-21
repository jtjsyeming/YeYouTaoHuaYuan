using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace jtjsym.Services;

/// <summary>
/// 一条榜单记录（H-018）。<see cref="Sec"/> 是通关用时（秒，<b>小者优</b>）。
/// <para><see cref="Ts"/> 只做人工排查用 —— <b>不参与任何判断</b>：不按它排序、不按它失效、不进任何断言。
/// 唯一目的就是"这个数字是什么时候写进来的"在翻文件时能看一眼。</para>
/// </summary>
public sealed record LlkRecord(int Sec, string Name, string Ts);

/// <summary>
/// 存储自检结果（D-40 / C-97）。
/// <para><see cref="Kind"/> 是给人和脚本看的<b>分类</b>：<c>ok</c> / <c>permission</c> / <c>path</c> / <c>io</c> / <c>unknown</c>。
/// <see cref="Error"/> 只放<b>异常类型名</b>，不放消息 —— 消息里带绝对路径，而 <c>/llkhealth</c> 是公开端点。</para>
/// </summary>
public sealed record LlkStorageProbe(bool Ok, string Kind, string? Error)
{
    /// <summary>唯一"健康"的那个实例：判定只比 <see cref="Ok"/>，别比引用。</summary>
    public static readonly LlkStorageProbe Healthy = new(true, "ok", null);
}

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

    private readonly ILogger<LianliankanLeaderboard>? _log;

    /// <summary>自检临时文件名。<b>与榜单的 <c>.tmp</c> 分开</b>，否则删自检残留会把正在写的档删掉。</summary>
    private const string ProbeFileName = "selfcheck.tmp";

    /// <summary>自检结果缓存时长：被打也不该变成 IO 压测。</summary>
    private static readonly TimeSpan ProbeTtl = TimeSpan.FromSeconds(10);

    /// <summary>
    /// 最近一次自检结果。<b><c>null</c> = 这辈子还没探过</b> —— 日历页徽标据此"初值未知则不显示"。
    /// 除了 <see cref="EnsureWritableAsync"/>，<see cref="SaveAsync"/> 的成败也会刷新它，
    /// 否则没人访问 <c>/llkhealth</c> 时徽标永远不出现，等于没做。
    /// </summary>
    private volatile LlkStorageProbe? _probe;

    private DateTimeOffset _probeAt;

    /// <summary>
    /// 构造<b>只算路径、不读盘</b>：启动时的 IO 失败不能让站点起不来。
    /// </summary>
    /// <param name="logger">
    /// 可空：单测直接 <c>new</c> 时不必造一个 logger。<b>写失败必须留痕</b>——
    /// D-40 事故的另一半就是"ECS 侧 <c>stdoutLogEnabled=false</c> + 代码里一个日志都不打"。
    /// </param>
    public LianliankanLeaderboard(IConfiguration cfg, ILogger<LianliankanLeaderboard>? logger = null)
    {
        _log = logger;
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

    // ───────────────────────── 自检（D-40 / C-97） ─────────────────────────

    /// <summary>最近一次自检结果；<c>null</c> = 还没探过（徽标据此不显示）。</summary>
    public LlkStorageProbe? LastProbe => _probe;

    /// <summary>
    /// 异常 → 分类。自检与提交反馈<b>共用这一处</b>，别在两处各写一套 <c>switch</c>
    /// —— 两套分类迟早对不上，而"到底是什么失败"正是这次事故的核心。
    /// </summary>
    /// <remarks>
    /// <b>顺序要紧</b>：<see cref="DirectoryNotFoundException"/> / <see cref="PathTooLongException"/>
    /// 都继承自 <see cref="IOException"/>，必须排在它前面，否则路径类故障会被归成 <c>io</c>。
    /// </remarks>
    public static string Classify(Exception ex) => ex switch
    {
        UnauthorizedAccessException => "permission",
        DirectoryNotFoundException => "path",
        PathTooLongException => "path",
        NotSupportedException => "path",          // 路径含非法字符 / 不是绝对路径
        ArgumentException => "path",
        IOException => "io",                      // 磁盘满、被独占、网络盘掉线
        _ => "unknown",
    };

    /// <summary>
    /// 真的试写一次：建目录 → 写 <c>selfcheck.tmp</c> → 删掉。<b>失败不抛</b>，返回分类。
    /// </summary>
    /// <remarks>
    /// <para><b>为什么不能只看 <c>Directory.CreateDirectory</c></b>：它对已存在的目录是幂等的、不抛；
    /// 权限不足往往在随后的 <c>WriteAllTextAsync</c> 才炸（实测）。只看建目录 ⇒ 权限故障自检报"健康"。</para>
    /// <para><b>为什么只能显式调用</b>（<c>/llkhealth</c>、日历页 <c>?diag=1</c>）：试写有副作用。
    /// 挂在日历页渲染上就把"纯读页面"变成写页面，U13-6 当场变红。</para>
    /// </remarks>
    public async Task<LlkStorageProbe> EnsureWritableAsync(CancellationToken ct = default)
    {
        var cached = _probe;
        if (cached is not null && DateTimeOffset.UtcNow - _probeAt < ProbeTtl) return cached;

        await _gate.WaitAsync(ct);
        try
        {
            cached = _probe;                                              // 双检：拿锁期间可能刚有人探过
            if (cached is not null && DateTimeOffset.UtcNow - _probeAt < ProbeTtl) return cached;

            var tmp = Path.Combine(_dir, ProbeFileName);
            LlkStorageProbe probe;
            try
            {
                Directory.CreateDirectory(_dir);
                await File.WriteAllTextAsync(tmp, "ok", ct);
                probe = LlkStorageProbe.Healthy;
            }
            catch (Exception ex)
            {
                probe = new LlkStorageProbe(false, Classify(ex), ex.GetType().Name);
                _log?.LogWarning(ex, "llk 榜数据目录不可写：dir={Dir} kind={Kind}", _dir, probe.Kind);
            }
            finally
            {
                // 成功也要删 —— 自检不许留痕（U14-3）；删不掉不算失败，下次自检会覆盖它
                try { File.Delete(tmp); } catch { }
            }

            _probe = probe;
            _probeAt = DateTimeOffset.UtcNow;
            return probe;
        }
        finally
        {
            _gate.Release();
        }
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
                        // H-023：方块数不符（含"老文件没有 n 键"）⇒ 旧盘面的成绩，整条作废。
                        // 这一行就是"上线不用手动清档"的全部实现。
                        if (rec.N != LianliankanThemes.PlayableCount(issue)) continue;
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
    /// <remarks>
    /// 失败<b>记一条日志再原样抛出</b>：调用方（页面）负责给用户看文案，这里负责让运维在日志里看得见。
    /// D-40 事故里"点了没反应"能挂一整轮，正是因为 catch 全吞、日志一条没有。
    /// </remarks>
    private async Task SaveAsync(Dictionary<int, LlkRecord> map, CancellationToken ct)
    {
        try
        {
            Directory.CreateDirectory(_dir);              // ⚠ 每次都要：跑批中途目录会被清（见类注释）

            var payload = new Dictionary<int, LlkFileRecord>(map.Count);
            foreach (var (issue, rec) in map)
            {
                // n 由点阵现算（不是从 LlkRecord 带过来）：写入侧与读取侧必须同一处算法，
                // 否则改图之后"新写进去的档自己都读不回来"。
                payload[issue] = new LlkFileRecord
                {
                    Sec = rec.Sec,
                    Name = rec.Name,
                    Ts = rec.Ts,
                    N = LianliankanThemes.PlayableCount(issue),
                };
            }

            var tmp = FilePath + ".tmp";
            await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(payload, JsonOpts), ct);
            File.Move(tmp, FilePath, overwrite: true);

            _probe = LlkStorageProbe.Healthy;              // 写成功了 ⇒ 目录确实可写，徽标该灭
            _probeAt = DateTimeOffset.UtcNow;
        }
        catch (Exception ex)
        {
            _probe = new LlkStorageProbe(false, Classify(ex), ex.GetType().Name);
            _probeAt = DateTimeOffset.UtcNow;
            _log?.LogError(ex, "llk 榜写入失败：dir={Dir} kind={Kind}", _dir, Classify(ex));
            throw;
        }
    }

    /// <summary>落盘形状：<c>{"20261101":{"sec":123,"name":"阿P","ts":"…","n":198}}</c>。</summary>
    private sealed class LlkFileRecord
    {
        [JsonPropertyName("sec")] public int Sec { get; set; }
        [JsonPropertyName("name")] public string? Name { get; set; }
        [JsonPropertyName("ts")] public string? Ts { get; set; }

        /// <summary>
        /// 这一关的可消除方块数（H-023）。<b>读的时候按它作废旧盘面的成绩</b> ——
        /// 盘面从 48 格变成 320 格（每月 134~216 块），旧成绩与新盘面没有可比性。
        /// </summary>
        /// <remarks>
        /// 用"存 n + 读取时校验"而不是"上线当天手动清 <c>llk-records.json</c>"：后者漏做一次，
        /// 症状与做对完全一样（旧纪录挂着、永远打不破），而 ECS 上没人会去核对。
        /// 校验放读取侧 ⇒ 老文件不需要任何迁移动作，下一次写入自然把它洗干净。
        /// </remarks>
        [JsonPropertyName("n")] public int? N { get; set; }
    }
}
