using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace LadServer;

/// <summary>
/// Runs the dashboard's saved RealWare ListBuilder searches and saves the results as JSON files
/// the dashboard reads. Read-only: it signs in and runs saved searches; it never changes RealWare data.
/// </summary>
public sealed class Refresher(IConfiguration config, IWebHostEnvironment env, ILogger<Refresher> log)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly object _lock = new();
    private RefreshStatus _status = new();

    public RefreshStatus Status { get { lock (_lock) return _status with { }; } }
    private void Set(Func<RefreshStatus, RefreshStatus> f) { lock (_lock) _status = f(_status); }

    private string DataDir => Path.Combine(env.WebRootPath, "data", "raw");

    /// <summary>Starts a refresh in the background. Returns false if one is already running or ran too recently.</summary>
    public bool TryStart(string reason)
    {
        var minGap = TimeSpan.FromMinutes(config.GetValue("Refresh:MinMinutesBetweenRefreshes", 5));
        var last = Status.LastRefresh;
        if (reason == "button" && last is not null && DateTimeOffset.UtcNow - last < minGap) return false;
        if (!_gate.Wait(0)) return false;
        // Mark as running before returning, so the very next status check already reports it.
        Set(s => s with { Running = true, Step = "starting", LastError = null });
        _ = Task.Run(() => RunLockedAsync(reason));
        return true;
    }

    /// <summary>Runs a refresh (waits if one is already in progress). Used by the weekly schedule.</summary>
    public async Task RunAsync(string reason)
    {
        await _gate.WaitAsync();
        Set(s => s with { Running = true, Step = "starting", LastError = null });
        await RunLockedAsync(reason);
    }

    private async Task RunLockedAsync(string reason)
    {
        var started = DateTimeOffset.UtcNow;
        Set(s => s with { Step = "signing in" });
        log.LogInformation("Refresh started ({Reason})", reason);
        try
        {
            var searches = LoadSearches(out var salesYears);
            using var http = CreateClient();
            var token = await GetTokenAsync(http);
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

            // Fetch everything first; only replace the saved files if every search succeeded.
            var results = new Dictionary<string, JsonArray>();
            foreach (var s in searches)
            {
                Set(st => st with { Step = $"{s.Title} ({results.Count + 1} of {searches.Count})" });
                var rows = await RunSearchAsync(http, s);
                rows = Slim(rows, s, salesYears);
                CheckRowCount(s, rows.Count);
                results[s.Name] = rows;
                log.LogInformation("{Search}: {Rows} rows", s.Title, rows.Count);
            }

            Set(st => st with { Step = "saving" });
            Directory.CreateDirectory(DataDir);
            foreach (var (name, rows) in results)
            {
                var tmp = Path.Combine(DataDir, name + ".json.tmp");
                await File.WriteAllTextAsync(tmp, rows.ToJsonString());
                File.Move(tmp, Path.Combine(DataDir, name + ".json"), overwrite: true);
            }
            var now = DateTimeOffset.UtcNow;
            var finished = now.AddTicks(-(now.Ticks % TimeSpan.TicksPerSecond));   // whole seconds: same text in meta.json and api/status
            var meta = new JsonObject
            {
                ["refreshedAt"] = finished.ToString("yyyy-MM-ddTHH:mm:sszzz"),
                ["source"] = "RealWare ListBuilder searches",
                ["counts"] = new JsonObject(results.Select(r => KeyValuePair.Create(r.Key, (JsonNode?)r.Value.Count))),
            };
            await File.WriteAllTextAsync(Path.Combine(DataDir, "meta.json"), meta.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            Set(st => st with { LastRefresh = finished, LastDurationSeconds = (int)(now - started).TotalSeconds });
            log.LogInformation("Refresh finished in {Seconds}s", (int)(now - started).TotalSeconds);
        }
        catch (Exception ex)
        {
            log.LogError(ex, "Refresh failed; previous data kept");
            Set(st => st with { LastError = ex.Message });
        }
        finally
        {
            Set(st => st with { Running = false, Step = null });
            _gate.Release();
        }
    }

    /// <summary>Reads refreshedAt from the last saved meta.json so status survives restarts.</summary>
    public void LoadLastRefresh()
    {
        try
        {
            var meta = JsonNode.Parse(File.ReadAllText(Path.Combine(DataDir, "meta.json")));
            if (DateTimeOffset.TryParse(meta?["refreshedAt"]?.GetValue<string>(), out var t)) Set(s => s with { LastRefresh = t });
        }
        catch { /* no data yet */ }
    }

    public bool HasData => File.Exists(Path.Combine(DataDir, "meta.json"));

    // ------------------------------------------------------------------ API calls

    private HttpClient CreateClient()
    {
        var handler = new HttpClientHandler();
        if (config.GetValue("Realware:IgnoreCertificateErrors", false))
            handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        var baseUrl = config["Realware:BaseUrl"];
        if (string.IsNullOrWhiteSpace(baseUrl)) throw new InvalidOperationException("Realware:BaseUrl is not set in appsettings.");
        return new HttpClient(handler)
        {
            BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"),
            Timeout = TimeSpan.FromMinutes(config.GetValue("Realware:TimeoutMinutes", 10)),
        };
    }

    private async Task<string> GetTokenAsync(HttpClient http)
    {
        var body = new JsonObject
        {
            ["GrantType"] = config["Realware:GrantType"] ?? "password",
            ["Username"] = config["Realware:Username"],
            ["Password"] = config["Realware:Password"],
        };
        using var res = await http.PostAsync("api/authentication/token", new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"RealWare sign-in failed (HTTP {(int)res.StatusCode}). Check Realware:Username / Password.");
        var token = JsonNode.Parse(text)?["AccessToken"]?.GetValue<string>();
        if (string.IsNullOrEmpty(token)) throw new InvalidOperationException("RealWare sign-in returned no token.");
        return token;
    }

    private async Task<JsonArray> RunSearchAsync(HttpClient http, Search s)
    {
        var max = config.GetValue("Realware:MaxResults", 500000);
        var url = $"api/listbuilder/realware/{s.QueryId}?maxResults={max}&taxyear=0";
        using var res = await http.PostAsync(url, new StringContent("[]", Encoding.UTF8, "application/json"));
        var text = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode) throw new InvalidOperationException($"{s.Title} (query {s.QueryId}) failed: HTTP {(int)res.StatusCode}.");
        var node = JsonNode.Parse(text);
        // A list of row objects (also accepts the list wrapped in an object).
        var rows = node as JsonArray ?? (node as JsonObject)?.Select(p => p.Value).OfType<JsonArray>().FirstOrDefault()
                   ?? throw new InvalidOperationException($"{s.Title}: unexpected response (not a list of rows).");
        if (rows.Count >= max) throw new InvalidOperationException($"{s.Title}: returned {rows.Count} rows, the maxResults limit; results may be cut off. Raise Realware:MaxResults.");
        return rows;
    }

    // ------------------------------------------------------------------ shaping & safety checks

    private static string Norm(string k) => Regex.Replace(k.ToUpperInvariant(), "[^A-Z0-9]", "");

    /// <summary>Keeps only the configured columns (matched ignoring case/punctuation) and, for sales, recent rows.</summary>
    private static JsonArray Slim(JsonArray rows, Search s, int salesYears)
    {
        var keep = s.Keep.Select(Norm).ToHashSet();
        var cutoff = DateTime.Today.AddYears(-salesYears);
        var dateKey = s.DateColumn is null ? null : Norm(s.DateColumn);
        var outRows = new JsonArray();
        foreach (var row in rows.OfType<JsonObject>())
        {
            var o = new JsonObject();
            foreach (var (k, v) in row)
            {
                var nk = Norm(k);
                if (dateKey is not null && nk == dateKey)
                {
                    if (!TryDate(v, out var d) || d < cutoff) { o = null; break; }
                }
                if (keep.Contains(nk)) o[k] = v?.DeepClone();
            }
            if (o is not null) outRows.Add(o);
        }
        return outRows;
    }

    private static bool TryDate(JsonNode? v, out DateTime d)
    {
        var text = v?.ToString() ?? "";
        string[] formats = ["yyyy-MM-dd", "yyyy-MM-ddTHH:mm:ss", "yyyy-MM-ddTHH:mm:ss.fff", "M/d/yyyy", "M/d/yyyy h:mm:ss tt"];
        return DateTime.TryParseExact(text.Length > 23 ? text[..19] : text, formats, CultureInfo.InvariantCulture, DateTimeStyles.None, out d)
            || DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out d);
    }

    /// <summary>Refuses to replace good data with an empty or much smaller result (e.g. a broken search).</summary>
    private void CheckRowCount(Search s, int count)
    {
        if (count == 0) throw new InvalidOperationException($"{s.Title} returned no rows.");
        var path = Path.Combine(DataDir, s.Name + ".json");
        if (!File.Exists(path)) return;
        var previous = JsonNode.Parse(File.ReadAllText(path)) is JsonArray a ? a.Count : 0;
        var ratio = config.GetValue("Refresh:MinRowRatio", 0.5);
        if (previous > 0 && count < previous * ratio)
            throw new InvalidOperationException($"{s.Title} returned {count} rows, down from {previous}. Not saved; check the search in ListBuilder.");
    }

    private List<Search> LoadSearches(out int salesYears)
    {
        var json = JsonNode.Parse(File.ReadAllText(Path.Combine(env.WebRootPath, "config", "searches.json")))!;
        salesYears = json["salesYearsToKeep"]?.GetValue<int>() ?? 10;
        return json["searches"]!.AsArray().Select(n => new Search(
            n!["name"]!.GetValue<string>(), n["queryId"]!.GetValue<long>(), n["title"]?.GetValue<string>() ?? n["name"]!.GetValue<string>(),
            n["keep"]!.AsArray().Select(k => k!.GetValue<string>()).ToList(), n["dateColumn"]?.GetValue<string>())).ToList();
    }

    private sealed record Search(string Name, long QueryId, string Title, List<string> Keep, string? DateColumn);
}

public sealed record RefreshStatus
{
    public bool Running { get; init; }
    public string? Step { get; init; }
    public DateTimeOffset? LastRefresh { get; init; }
    public int? LastDurationSeconds { get; init; }
    public string? LastError { get; init; }
}

/// <summary>Runs the refresh once a week (default Sunday 2 AM server time), and at startup if no data has been saved yet.</summary>
public sealed class WeeklySchedule(Refresher refresher, IConfiguration config, ILogger<WeeklySchedule> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        refresher.LoadLastRefresh();
        if (!refresher.HasData) await refresher.RunAsync("first start");
        while (!stop.IsCancellationRequested)
        {
            var next = NextRun(DateTime.Now);
            log.LogInformation("Next scheduled refresh: {Next}", next);
            try { await Task.Delay(next - DateTime.Now, stop); } catch (TaskCanceledException) { return; }
            await refresher.RunAsync("weekly schedule");
        }
    }

    private DateTime NextRun(DateTime now)
    {
        var day = Enum.Parse<DayOfWeek>(config["Refresh:DayOfWeek"] ?? "Sunday", ignoreCase: true);
        var hour = config.GetValue("Refresh:Hour", 2);
        var next = now.Date.AddHours(hour).AddDays(((int)day - (int)now.DayOfWeek + 7) % 7);
        return next <= now ? next.AddDays(7) : next;
    }
}
