# opencode-usage-plans

A TUI plugin for OpenCode that shows subscription quota for the providers you
use, under one `Usage` block in the sidebar.

## What it shows

- **Kimi Code**: the 5-hour and monthly windows of a Kimi Code plan, each with
  a colored bar, the used percentage, what is left, and when it resets.
- **Alibaba Cloud Token Plan**: the monthly window, read through the official
  `bl` CLI.
- **OpenAI Codex**: the 5-hour and weekly ChatGPT plan windows.

Each provider is detected at startup. A provider that is not installed or has no
credentials is simply not shown — there is no error and no empty block. The
`Usage` header appears only when at least one provider is loading or has data.

Quota refreshes every 5 minutes, so signing in again takes effect without
restarting OpenCode.

## Install

Add the plugin to the `plugins` array in `~/.config/opencode/cli.json`:

```json
{
  "plugins": [
    "opencode-session-clock@0.1.1",
    "opencode-session-stats@0.1.0",
    "opencode-usage-plans@0.2.0"
  ]
}
```

To override options, use the object form:

```json
{
  "plugins": [
    {
      "package": "opencode-usage-plans@0.2.0",
      "options": {
        "kimi": { "enabled": true },
        "alibaba": { "enabled": true, "blPath": "/usr/local/bin/bl" }
      }
    }
  ]
}
```

The order above — clock, stats, usage — is the recommended sidebar order.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `kimi.enabled` | `true` | Show the Kimi Code block when a Kimi key is present. |
| `alibaba.enabled` | `true` | Show the Alibaba block when `bl` is present. |
| `openai.enabled` | `true` | Show the OpenAI Codex block when OpenAI credentials are present. |
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

## Privacy

Quota requests go only to `api.kimi.ai` and `chatgpt.com`; the Alibaba block
runs the local `bl` CLI. Tokens are read from local auth files and sent only to
their own provider. No keys, file paths, or raw errors are rendered in the
sidebar.

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
- Invalid options: OpenCode logs a plugin load error; remove the option and
  reload the config.

## License

MIT