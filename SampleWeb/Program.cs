using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/config.js", (IConfiguration configuration) =>
{
    var apiBaseUrl = configuration["ProductsApiUrl"] ?? "http://localhost:8080";
    var script = $"window.productCatalogConfig = {{ apiBaseUrl: {JsonSerializer.Serialize(apiBaseUrl.TrimEnd('/'))} }};";
    return Results.Content(script, "application/javascript");
});

app.MapGet("/health", () => Results.Ok(new { status = "Healthy" }));

app.Run();
