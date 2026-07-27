# ForeXplore C# Target Workspace

This .NET 8 project is the target workspace currently exposed by the ForeXplore web module tree. The supporting application and in-memory infrastructure are complete; `QuoteOrchestrationService.GetQuoteAsync` remains as the single Java-to-C# translation target.

## Layout

- `src/Domain`: records and typed settlement outcomes.
- `src/Ports`: provider, cache, and audit boundaries.
- `src/Application`: the primary translation targets.
- `src/Infrastructure`: target-side in-memory adapters.
- `tests/RequirementsMatrix.cs`: framework-independent acceptance requirements.

## Build

```text
dotnet build ForeXplore.Skeleton.csproj
dotnet run --project ForeXplore.Skeleton.csproj
```

The default host exercises settlement and audit behavior without calling the remaining target. After backfilling `GetQuoteAsync`, run with `--quote` to include the quote workflow:

```text
dotnet run --project ForeXplore.Skeleton.csproj -- --quote
```

`TODO`/`NotImplementedException` marks the one intentional translation input. `REQ:` comments are executable-design constraints and are deliberately excluded from the frontend incomplete-module scan. The project has no build-time dependency on the Java corpus repository.

All source is synthetic and released under the MIT license for benchmark use.
