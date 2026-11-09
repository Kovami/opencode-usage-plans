# opencode-usage-plans

A standalone TUI plugin for OpenCode that shows subscription quota for the
providers you use, under one `Usage` block in the sidebar. It lives in its own
repository and works on its own — nothing else to install.

## What it shows

- **Kimi Code**: the 5-hour and monthly windows of a Kimi Code plan, each with
  a colored bar, the used percentage, what is left, and when it resets.
- **Alibaba Cloud Token Plan**: the monthly window, read through the official
  `bl` CLI.
- **OpenAI Codex**: the 5-hour and weekly ChatGPT plan windows.
- **Z.AI Coding Plan**: the rolling 5-hour and weekly token windows plus the
  MCP/tools window, each with its reset time.

Each provider is detected at startup. A provider that is not installed or has no
credentials is simply not shown — there is no error and no empty block. The
`Usage` header appears only when at least one provider is loading or has data.

Quota refreshes every 5 minutes, so signing in again takes effect without
restarting OpenCode. The OpenAI Codex block refreshes an expiring OAuth token
by itself, so usage keeps updating in the background even when the model is
not in use.

Providers are sorted by last use: the ones you used most recently sit at the
top, and the rest follow in alphabetical order. A provider counts as used when
a session selects its model or starts an execution with it, and this order is
remembered across restarts.

## Install

`opencode-usage-plans` is a standalone plugin: one npm package, no other
plugins, servers, or accounts required. It reads credentials that OpenCode or
the provider CLIs already have and renders quota in the sidebar.

### Manually

Add the plugin to the `plugins` array in `~/.config/opencode/cli.json`. If you
already have that file, add one entry; if not, create it:

```json
{
  "plugins": ["opencode-usage-plans@0.3.0"]
}
```

Restart OpenCode. The `Usage` block appears once any supported provider's
credentials are found — see [Requirements](#requirements).

To override options, use the object form:

```json
{
  "plugins": [
    {
      "package": "opencode-usage-plans@0.3.0",
      "options": {
        "kimi": { "enabled": true },
        "alibaba": { "enabled": true, "blPath": "/usr/local/bin/bl" }
      }
    }
  ]
}
```

### Let your agent install it

Paste this prompt into OpenCode (or any coding agent with shell access):

```text
Install the opencode-usage-plans plugin for me:

1. Read ~/.config/opencode/cli.json. If it does not exist, create it with {}.
2. Add "opencode-usage-plans@0.3.0" to the "plugins" array. Keep every
   existing entry and keep the file valid JSON.
3. Print the resulting "plugins" array so I can verify it.

Do not change anything else in the file.
```

Then restart OpenCode.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `kimi.enabled` | `true` | Show the Kimi Code block when a Kimi key is present. |
| `alibaba.enabled` | `true` | Show the Alibaba block when `bl` is present. |
| `openai.enabled` | `true` | Show the OpenAI Codex block when OpenAI credentials are present. |
| `zai.enabled` | `true` | Show the Z.AI block when a Z.AI key is present. |
| `zai.baseUrl` | `https://api.z.ai` | Z.AI API base URL. Use `https://open.bigmodel.cn` for China accounts. |
| `alibaba.blPath` | auto-detected | Path to the `bl` CLI. Detection probes `PATH`, then `~/.npm-global/bin`, `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`. |
| `alibaba.region` | `ap-southeast-1` | Value passed to `bl usage token-plan --console-region`. |
| `alibaba.site` | `international` | Value passed to `bl usage token-plan --console-site`. |

## Requirements

- OpenCode 2.2 or newer.
- **Kimi Code**: sign in to your Kimi Code plan in OpenCode. The plugin reads
  the `kimi-code-plan-global` key from the local `auth.json`; the key is used
  only in the request header and is never displayed.
- **Alibaba Cloud**: install the official `bl` CLI and run `bl login`. The API
  key used for inference cannot read quota, so the CLI is required.
- **OpenAI Codex**: sign in to Codex CLI with `codex login` (the plugin reads
  `~/.codex/auth.json`), or use OpenCode login for OpenAI with ChatGPT OAuth.
- **Z.AI Coding Plan**: set `ZAI_API_KEY`, or store the key in the local
  `auth.json` under `zai-coding-plan`, `zai`, `zhipuai-coding-plan`, or
  `zhipuai`. The key is used only in the request header and is never displayed.

## Privacy

Quota requests go only to `api.kimi.ai`, `chatgpt.com`, and `api.z.ai` (or
`open.bigmodel.cn` when configured), and token refresh requests only to
`auth.openai.com`; the Alibaba block runs the local `bl` CLI. Tokens are read
from local auth files and sent only to their own provider. When OpenAI rotates
a refresh token, the plugin writes the new pair back to the same auth file it
read them from, so the Codex CLI and OpenCode stay in sync. The plugin also
stores one timestamp per provider — when each was last used — through the
standard OpenCode plugin storage; no other data is persisted. No keys, file
paths, or raw errors are rendered in the sidebar.

## Development

```sh
git clone https://github.com/Kovami/opencode-usage-plans.git
cd opencode-usage-plans
npm install
npm run check
```

To run a local checkout in OpenCode, point `cli.json` at the folder instead of
the npm name:

```json
{
  "plugins": [
    { "package": "/absolute/path/to/opencode-usage-plans" }
  ]
}
```

## Troubleshooting

- Nothing appears: make sure the plugin is listed in `~/.config/opencode/cli.json`
  (the CLI configuration), not in `opencode.json`.
- OpenCode 2.2 or newer is required. After saving the config, check
  `~/.local/share/opencode/log/opencode.log` for `plugin` lines.
- Kimi block missing: sign in to Kimi Code in OpenCode so
  `auth.json` contains `kimi-code-plan-global`.
- Alibaba block missing: run `bl login`, or set `alibaba.blPath` if `bl` lives
  outside `PATH` and the usual install locations.
- OpenAI Codex block missing: sign in to Codex CLI (`codex login`), or log in
  to OpenAI (ChatGPT) in OpenCode so `auth.json` contains `openai-codex`.
- OpenAI Codex shows "Codex sign-in expired": the plugin refreshes expiring
  tokens on its own, so this message means the stored sign-in was rejected or
  revoked — run `codex login` again.
- Z.AI block missing: set `ZAI_API_KEY` or add a Z.AI key entry to `auth.json`.
  For China accounts, set `zai.baseUrl` to `https://open.bigmodel.cn`.
- Invalid options: OpenCode logs a plugin load error; remove the option and
  reload the config.

## License

MIT