<h4 align="right"><strong>English</strong> | <a href="README.md">简体中文</a></h4>

<p align="center">
  <img src="resources/icon.svg" alt="GoTTY icon" width="72" height="72">
</p>

<h1 align="center">GoTTY Hub</h1>

<p align="center"><strong>Bring your GoTTY instances together in one terminal workspace.</strong></p>

<p align="center">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust">
  <img alt="React" src="https://img.shields.io/badge/React-19-149eca?style=flat-square&logo=react">
  <img alt="Terminal" src="https://img.shields.io/badge/xterm.js-6.x-111827?style=flat-square">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-amd64%20%2F%20arm64-2563eb?style=flat-square&logo=linux">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
</p>

GoTTY Hub is a self-hosted terminal workspace for [GoTTY](https://github.com/Xiechengqi/gotty). GoTTY instances connect outbound to Hub, giving users one web interface to sign in, switch terminals, and manage instance access. Browsers only need access to Hub, without reaching each device's GoTTY port directly.

Hub ships as a single binary with an embedded React / xterm.js frontend, backed by Rust / Axum and SQLite for accounts, device connections, and terminal relay. It shares GoTTY's WebTTY and display-preference core. PTYs and command processes run on the GoTTY devices.

Typical request path:

```text
browser
  -> HTTP / WebSocket
  -> gotty-hub
  -> authenticated terminal relay
  -> gotty (over its outbound WS / WSS connection)
  -> PTY
  -> local command / shell
```

Each instance represents GoTTY's current shared PTY. Multiple browsers can use the same session; closing a Hub tab leaves the remote command running.

## Features

- Username / password registration and login, with a fixed `admin` account and an interactive administrator-password setup on first launch.
- A flat sidebar of accessible instances, multiple tabs, two-pane split view, collapsible navigation, and terminal maximization.
- Split view pairs two named instances with left/right and active-pane labels. Choose either instance, swap sides, or resize with a pointer or keyboard. Sorting preserves the pair; reloads restore the layout, and narrow screens temporarily show one terminal.
- Mouse dragging, touch-and-hold, and keyboard sorting in the sidebar and tab bar, with synchronized order saved to user preferences.
- Status colors synchronized with GoTTY: red for active viewing, yellow for new output while not being viewed, green for output that has stopped but remains unread, and gray for no unread output. Offline instances use a separate icon.
- xterm.js terminals with Nord, bundled DejaVu Sans Mono, and 14px text by default. Settings → Terminal settings saves the theme, text size, and font for every terminal in your account, including the soft beige Paper theme (`#f5f5d5`).
- Additional open-source fonts load from Hub on demand and persist in the browser across reloads. Cursor and scrollback options still come from GoTTY.
- A terminal toolbar for connection counts, refreshing the current terminal, clearing history, file uploads, and authorized remote restart and share management. Restart uses a power icon and requires confirmation.
- The same two-row, 16-key mobile keyboard as GoTTY when the software keyboard opens, with one-shot Ctrl / Alt / Shift and repeating navigation keys.
- Owner, operator, and observer roles; terminal input, files, and voice follow both Hub permissions and GoTTY configuration.
- Native uploads, drag-and-drop uploads, ZMODEM transfers, and optional ASR voice input. ZMODEM requires `rz` / `sz` on the remote device.
- Automatic reconnect and output replay, plus device-credential rotation, disconnect, and unbinding.
- A Settings menu at the top right: Terminal settings, Console (statistics, online upgrades, restarts, and logs; `admin` only), Change password, and sign-out from this browser or every device. Terminal settings remains accessible with the workspace maximized or navigation collapsed.
- Single-file Linux amd64 / arm64 releases, with data stored under `~/.gotty-hub` by default.

## Quick Start

Linux amd64 installation:

```bash
wget https://github.com/Xiechengqi/gotty-hub/releases/download/latest/gotty-hub-linux-amd64 -O /usr/local/bin/gotty-hub && chmod +x /usr/local/bin/gotty-hub
```

Linux arm64 installation:

```bash
wget https://github.com/Xiechengqi/gotty-hub/releases/download/latest/gotty-hub-linux-arm64 -O /usr/local/bin/gotty-hub && chmod +x /usr/local/bin/gotty-hub
```

Start Hub for the first time:

```bash
gotty-hub
```

Enter a nonempty administrator password when prompted. The username is fixed as `admin`. The password is saved to `~/.gotty-hub/config` with mode `0600`; subsequent launches load the saved configuration.

Hub listens on `0.0.0.0:8088` by default. Open this address in a browser on the same machine:

```text
http://localhost:8088
```

For remote access, replace `localhost` with the server's IP address or a domain pointing to Hub. Sign in as `admin` to access administration, or register a regular account on the sign-in page.

## Connect GoTTY

Install a current version of [GoTTY](https://github.com/Xiechengqi/gotty) on the device you want to connect, then start an interactive terminal:

```bash
gotty --permit-write bash
```

After registering an account on Hub, open the GoTTY page and choose the Hub button in the upper-right toolbar. Fill in the panel beside the button:

| Field | Description |
| --- | --- |
| Hub address | The Hub root URL reachable from the GoTTY device, such as `https://hub.example.com` |
| Username | An existing Hub username, such as `alice` |
| Display name in Hub | Optional, such as `dev-workspace`; generated automatically when left blank |

Connecting requires only the Hub address and username, with no Hub password or verification code. An unknown username produces a prompt to register on Hub first. Instance names must be unique per user after trimming whitespace and ignoring ASCII letter case; duplicate names are rejected with a message.

A green message confirms success and the fields become read-only. Use Edit to change the configuration, Reconnect to reuse the instance identity, or Disconnect to stop the connection while keeping the settings. Hub support is enabled in GoTTY by default, with both HTTP and HTTPS accepted. Use `--hub-disabled` to disable it, or `--hub-allow-http=false` to require HTTPS.

Binding credentials are isolated by stable listening address, port and base path in `~/.gotty/hub/<identity>.json`, or `~/.gotty-hub-bindings/<identity>.json` when `~/.gotty` is a configuration file. Concurrent use of one identity file is rejected before starting the command. Legacy shared files are preserved and require explicit selection after ownership is verified; see [migration and workspace validation](docs/WORKSPACE_RECOVERY.md). GoTTY reuses its existing authentication when a password is configured; otherwise, visitors to the main GoTTY page can manage the binding. Share pages cannot manage Hub configuration.

## Accounts and Permissions

Regular usernames contain 3–64 ASCII letters, digits, dots, hyphens, or underscores, starting with a letter or digit. Login is case-insensitive. Regular-user passwords must be 12–256 bytes; the database stores Argon2id hashes.

Instance owners can grant access to other registered users in instance settings:

| Role | Capabilities |
| --- | --- |
| Owner | Use the terminal, manage access, rotate device credentials, and unbind; restart GoTTY and manage shares when supported by the device |
| Operator | Use terminal input, file transfers, and enabled voice input |
| Observer | View terminal output and adjust terminal display settings for their own account |

Writing still requires GoTTY's `--permit-write`; observers are always read-only. Knowing a username allows someone to register their own GoTTY instance to that user, but does not grant account login or access to existing instances.

To reset a regular user's forgotten password, run this on the Hub server:

```bash
gotty-hub users reset-password --username alice
```

A reset revokes the user's existing sessions. To recover administrator access, update the local configuration or start Hub with `--password`.

## Configuration

The default configuration file is `~/.gotty-hub/config`, using JSON:

```json
{
  "password": "YOUR_ADMIN_PASSWORD"
}
```

This file stores the original administrator password with mode `0600`, inside a `0700` directory. Administrator passwords must be nonempty, contain a non-whitespace character, and be at most 256 bytes.

Override the administrator password for a process:

```bash
gotty-hub serve --password 'YOUR_ADMIN_PASSWORD'
```

Explicitly save configuration, or check the saved configuration:

```bash
gotty-hub config --password 'YOUR_ADMIN_PASSWORD'
gotty-hub check
```

Password precedence is `--password` / `--password-stdin` > `HUB_PASSWORD` > config. With an existing configuration, startup arguments and environment overrides apply only to that process. The `config` subcommand persists settings and also accepts the alias `configure`. Use `--password-stdin` to read the password from standard input.

Common environment variables:

| Variable | Purpose |
| --- | --- |
| `HUB_LISTEN` | Listen address; defaults to `0.0.0.0:8088` |
| `HUB_HOME` | Data root; defaults to `~/.gotty-hub`; overrides must be absolute paths |
| `HUB_PASSWORD` | Administrator-password override, below CLI and above config |
| `HUB_TRUSTED_PROXIES` | Comma-separated trusted proxy IPs / CIDRs; defaults to loopback only; `none` disables forwarding headers |
| `HUB_DATABASE` | Custom SQLite connection URL; defaults to `hub.db` in the data directory |
| `HUB_ASSETS` | Optional complete frontend build directory; embedded assets are the default, and external assets are snapshotted at startup |

Trusted-proxy precedence is `--trusted-proxies` > `HUB_TRUSTED_PROXIES` > the config's `trusted_proxies` array > loopback defaults. See [administration and configuration](docs/ADMINISTRATION.md) (Chinese) for details.

## Console

Sign in as `admin`, open Settings at the right of the navigation bar, and choose Console:

- **Statistics**: users, registered / online / offline instances, active sessions, uptime, version, and commit.
- **Upgrade / restart**: check this repository's `latest` Release, verify SHA256, back up the binary and database, then replace and restart.
- **Logs**: view the tail of the current log with automatic refresh. Logs exclude passwords, cookies, device secrets, and terminal payloads.

Foreground Ctrl-C / SIGTERM and administrator restarts use the same shutdown flow, closing SSE / WebSocket connections while preserving user sessions, device bindings, and remote PTYs. Connections have a 3-second drain budget and total shutdown is bounded to 5 seconds. A second exit signal forces immediate termination.

## Reverse Proxies

Hub accepts any domain or IP pointing to it. Changing domains requires no configuration update or Hub restart. The legacy `--origin`, `HUB_ORIGIN`, and config `origin` options are accepted but ignored.

Use a reverse proxy for HTTPS. With the external `Host` preserved, the browser's origin can identify the current HTTPS address. If the proxy rewrites `Host`, a trusted proxy must overwrite `X-Forwarded-Host`. The browser origin's domain and port must still match the current request address.

Add this to the Nginx `http` context:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
```

Use this inside a `server` with its domain and TLS certificates configured:

```nginx
location / {
    proxy_pass http://127.0.0.1:8088;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 24h;
}
```

The proxy must support WebSocket and disable SSE buffering. Container or remote proxies that rewrite `Host` need their actual proxy IPs / CIDRs configured as trusted. See [deployment and operations](docs/OPERATIONS.md) (Chinese) for Caddy, Docker Compose, backups, recovery, and page-resource caching.

## Files and Runtime State

| Path | Purpose |
| --- | --- |
| `~/.gotty-hub/config` | Administrator password and optional trusted-proxy settings |
| `~/.gotty-hub/hub.db` | SQLite accounts, access grants, sessions, instances, and preferences |
| `~/.gotty-hub/logs/hub.log.*` | Rotating logs |
| `~/.gotty-hub/ui-assets/` | Hashed frontend assets for the current and previous two builds |
| `~/.gotty-hub/upgrade.json` | Upgrade state |
| `~/.gotty-hub/updates/` | Upgrade staging, previous binary, and database backups |

`HUB_HOME` overrides the entire data root. GoTTY PTYs, commands, and device identities remain on their respective devices.

## Build

Requires Rust stable, Node.js 24, npm, and GNU Make:

```bash
git clone https://github.com/Xiechengqi/gotty-hub.git
cd gotty-hub
make build
```

The resulting `target/release/gotty-hub` includes frontend assets. The shared terminal core is pinned through a versioned package with npm integrity under `frontend/vendor/`, so Hub builds independently.

For development, build the frontend first, then start the backend:

```bash
cargo run --locked
```

Start Vite in another terminal:

```bash
cd frontend
npm run dev -- --port 5178
```

Open `http://localhost:5178`; Vite forwards API / Connector requests to `8088`. `?preview=1` displays demo data only.

## Validation and Releases

Unit tests and static checks:

```bash
make check
cargo test --locked
(cd frontend && npm test)
python3 scripts/check-core.py
git diff --check
```

The [release workflow](.github/workflows/build-release.yml) runs on pushes to `main`, `v*` tags, or manual dispatch. It runs frontend tests, Rust checks, and isolated-process regressions for configuration setup, HTTPS proxies, WSS / SSE, shutdown and restart, and the production UI.

After validation, it builds static musl binaries and SHA256 files for Linux amd64 / arm64, then updates the Release named and tagged `latest`. Download URLs stay the same, while release notes record the actual commit. Real-GoTTY integration and load scripts are available in [run-integration.py](tests/run-integration.py) and [run-load.py](tests/run-load.py).

## Project Documentation

The following detailed documents are currently in Chinese:

- [Administration, configuration, and online updates](docs/ADMINISTRATION.md)
- [Deployment, reverse proxies, backup, and recovery](docs/OPERATIONS.md)
- [Architecture decisions, protocol, and compatibility](docs/ARCHITECTURE_DECISIONS.md)
- [API and device protocol](docs/API.md)
- [Terminal and device-binding review](docs/TERMINAL_AND_BINDING_REVIEW.md)
- [Page loading, mobile terminals, and synchronized sorting review](docs/UI_LOADING_AND_TERMINAL_REVIEW.md)
- [Account terminal settings and font caching](docs/TERMINAL_SETTINGS.md)
- [Terminal settings and fonts review](docs/TERMINAL_SETTINGS_REVIEW.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) and [historical review](docs/IMPLEMENTATION_REVIEW.md)

## License

[MIT](LICENSE)
