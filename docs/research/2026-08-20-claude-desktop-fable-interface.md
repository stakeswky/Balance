# Claude Desktop managed Claude Code usage interface

## Observe

- Target process: Claude Desktop-managed Claude Code `2.1.234` under
  `~/Library/Application Support/Claude/claude-code/`.
- Target request: `GET https://api.anthropic.com/api/oauth/usage`.
- Required non-secret header: `anthropic-beta: oauth-2025-04-20`.
- Authentication source: Claude Desktop injects `CLAUDE_CODE_OAUTH_TOKEN` into
  the managed Claude Code child process. The standalone credentials file and
  Keychain entry are not necessarily the same active login state.

## Capture

- The managed child process was identified by its exact executable path; the
  adjacent `Contents/Helpers/disclaimer` wrapper must be excluded.
- Its environment contains the variable name `CLAUDE_CODE_OAUTH_TOKEN`.
- The token was used only in memory for one read-only request and was never
  printed or written to disk.
- Sanitized live response observed on 2026-08-20:

```json
{
  "status": 200,
  "five_hour": 40,
  "seven_day": 27,
  "limits": [
    { "kind": "session", "percent": 40 },
    { "kind": "weekly_all", "percent": 27 },
    {
      "kind": "weekly_scoped",
      "scope": { "model": { "display_name": "Fable" } },
      "percent": 25
    }
  ]
}
```

The user had seen 24% shortly before capture; the official value advanced to
25% by the time of the request.

## Rebuild

- Existing `parseClaudeUsagePayload()` already parses this response correctly.
- Existing `fetchClaudeUsage()` already sends the correct request.
- The missing link is credential discovery: Synq currently checks the
  standalone Claude Code credentials file and macOS Keychain, but not the
  active Claude Desktop-managed child process.

## Patch direction

- On macOS and only for the current home directory, enumerate exact
  Claude Desktop-managed Claude Code processes.
- Read `CLAUDE_CODE_OAUTH_TOKEN` from the matching process environment in
  memory, without logging, persisting, refreshing, or mutating the credential.
- Exclude wrapper/helper processes and reject unrelated executables.
- Keep the existing 30-second fetch cache and 60-minute stale-success cache.

## Output

- Official request and response shape are reproducible.
- The current Synq parser is compatible.
- Remaining work: add the managed-process auth reader with deterministic tests,
  then verify the running dashboard renders the live Fable percentage.
