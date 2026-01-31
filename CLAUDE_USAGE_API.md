# Claude Code Usage API

## Endpoint

```
GET https://api.anthropic.com/api/oauth/usage
```

## Authentication

Uses the OAuth token stored by Claude Code at `~/.claude/.credentials.json`.

**Required headers:**

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <accessToken from credentials>` |
| `anthropic-beta` | `oauth-2025-04-20` |

The `anthropic-beta` header is critical — without it, the API rejects OAuth authentication entirely.

## One-liner

```bash
curl -s 'https://api.anthropic.com/api/oauth/usage' \
  -H "Authorization: Bearer $(python3 -c "import json; print(json.load(open('$HOME/.claude/.credentials.json'))['claudeAiOauth']['accessToken'])")" \
  -H 'anthropic-beta: oauth-2025-04-20' | python3 -m json.tool
```

## Response format

```json
{
  "five_hour": {
    "utilization": 6.0,
    "resets_at": "2026-01-31T19:00:00.238143+00:00"
  },
  "seven_day": {
    "utilization": 2.0,
    "resets_at": "2026-02-06T14:00:00.238165+00:00"
  },
  "seven_day_oauth_apps": null,
  "seven_day_opus": null,
  "seven_day_sonnet": {
    "utilization": 0.0,
    "resets_at": null
  },
  "seven_day_cowork": null,
  "iguana_necktie": null,
  "extra_usage": {
    "is_enabled": false,
    "monthly_limit": null,
    "used_credits": null,
    "utilization": null
  }
}
```

**Fields:**

- `utilization` — percentage (0-100) of the rate limit consumed
- `resets_at` — ISO 8601 timestamp for when the window resets
- `five_hour` — rolling 5-hour usage window
- `seven_day` — rolling 7-day total usage window
- `seven_day_sonnet` / `seven_day_opus` — per-model breakdowns (null if unused)
- `extra_usage` — overuse billing info (if enabled on the account)

## How this was found

Extracted from Claude Code's bundled source (`cli.js` in the `@anthropic-ai/claude-code` npm package). The relevant function fetches from `${BASE_API_URL}/api/oauth/usage` with auth headers constructed from the local OAuth credentials. The beta header value `oauth-2025-04-20` is defined as a constant in the auth module.

## Credential file structure

```
~/.claude/.credentials.json
```

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1769900322223,
    "scopes": ["user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "max",
    "rateLimitTier": "default_claude_max_5x"
  }
}
```
