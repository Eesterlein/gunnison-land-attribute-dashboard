using LadServer;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.StaticFiles;

// Land Attribute Dashboard server: serves the dashboard (wwwroot/) and keeps its data current
// by running the saved RealWare ListBuilder searches weekly and when someone clicks Refresh.
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<Refresher>();
builder.Services.AddHostedService<WeeklySchedule>();
builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;
    o.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(["application/geo+json"]);
});

var app = builder.Build();
app.UseResponseCompression();

// Data files change weekly: make browsers check for a newer copy instead of caching blindly.
var types = new FileExtensionContentTypeProvider();
types.Mappings[".geojson"] = "application/geo+json";
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    ContentTypeProvider = types,
    OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "no-cache",
});

app.MapGet("/api/status", (Refresher r) => Results.Json(r.Status));
app.MapPost("/api/refresh", (Refresher r) =>
    r.TryStart("button") ? Results.Accepted() : Results.Conflict(new { message = "A refresh is already running or ran in the last few minutes." }));

app.Run();
