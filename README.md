# Account Switcher for Claude Code (unofficial)

[![VS Marketplace](https://img.shields.io/visual-studio-marketplace/v/faisalsannan.account-switcher-for-claude-code?label=VS%20Marketplace&color=2b2a33)](https://marketplace.visualstudio.com/items?itemName=faisalsannan.account-switcher-for-claude-code)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/faisalsannan.account-switcher-for-claude-code?color=d97757)](https://marketplace.visualstudio.com/items?itemName=faisalsannan.account-switcher-for-claude-code)
[![Open VSX](https://img.shields.io/open-vsx/v/faisalsannan/account-switcher-for-claude-code?label=Open%20VSX&color=2b2a33)](https://open-vsx.org/extension/faisalsannan/account-switcher-for-claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Run multiple Claude Code accounts at the same time in VS Code / code-server.
Every account stays logged in permanently. Each folder — and each new chat —
can use its own account. Switching never logs anything out and never
interrupts a running session.**

## What changed in v1.0

v0.x kept one account live at a time and *swapped* `~/.claude` snapshots on
every switch: window reloads, stale chat tabs, and snapshots whose tokens
expired while another account was live.

v1.0 removes the swapping entirely:

- **Every account is permanently live** in its own isolated config directory
  (`CLAUDE_CONFIG_DIR`). Logins are never moved, copied or replaced, so they
  cannot go stale and there is **no logout code path at all** — a reboot or VM
  shutdown cannot sign any account out.
- **"Switching" is just routing**: you choose which account **new** chats in a
  folder use. Chats that are already running keep their process and their
  account — different accounts genuinely run **concurrently**, side by side.
- **No window reloads.** Open a new chat and it's on the other account.
- Works for the Claude panel (GUI), the `claude` CLI in terminals, and both at
  once.

Profiles created with v0.x are migrated automatically on first activation
(details below) — stored logins are preserved.

> ## ⚠️ Warning — unofficial tool
> This extension is **not made or endorsed by Anthropic**. It works with the
> official Claude Code extension's documented `CLAUDE_CONFIG_DIR` mechanism
> and its `claudeCode.claudeProcessWrapper` setting. It never edits, prints or
> logs tokens, and it never modifies the Anthropic extension itself.
>
> Profile directories contain **login credentials** (exactly like `~/.claude`
> does). The profiles folder is created with `700` permissions — do not commit
> it, sync it, or loosen it.

## How it works

```
~/.claude                       # your original account — untouched, now the
~/.claude.json                  # "default" profile
~/.claude-profiles/
├── map.conf                    # folder → account routing (longest prefix wins)
├── _default.label              # optional display name for the default account
├── Work/                       # a complete, live CLAUDE_CONFIG_DIR:
│   ├── .credentials.json       #   this account's own login (never moved)
│   ├── .claude.json            #   its own account state & workspace trust
│   ├── settings.json           #   its own settings (seeded from default)
│   ├── profile.json            #   metadata for this extension
│   └── projects/ sessions/ …   #   its own history, fully isolated
├── Personal/
│   └── ...
├── _bin/
│   ├── claude-wrapper.sh       # tiny launcher the official extension calls
│   ├── profile-env.sh          # the routing logic (also usable in terminals)
│   └── resolve.log             # routing breadcrumbs (paths only, no secrets)
└── _backups/                   # login snapshots & legacy v0.x backups
```

When the official Claude extension (or a terminal launcher) starts a new
Claude process, the wrapper picks the account for it:

1. `CLAUDE_CONFIG_DIR` already set in the environment → respected untouched
2. `CLAUDE_PROFILE=<name>` in the environment → that profile
3. a `.claude-profile` file in the folder (or any parent up to `~`) → that profile
4. longest matching folder prefix in `map.conf` → that profile
5. otherwise → the default account (`~/.claude`)

Routing picks a directory for a **new** process and nothing else: no files
move, no tokens are read, nothing is logged in or out. That is why a switch
can never break a session that is already running — that session's process
keeps its own config directory until it exits.

## Full usage guide

### First-time setup (adding a second account)

1. `Ctrl+Shift+P` → **Claude Accounts: Add Account** → name it (e.g. `Work`).
2. A terminal opens for that profile — complete the login there with the
   second account (type `/login` if not prompted). Close the terminal when
   done. **That's the only login this profile will ever need**: it survives
   switches, reboots and shutdowns.
3. When asked, enable **folder routing** (one-time consent — it sets the
   official extension's `claudeCode.claudeProcessWrapper` setting to the
   wrapper script above).

### Day-to-day switching

- **Click the status bar item** (`👤 Claude: <account>`, bottom left) or run
  **Claude Accounts: Use Account for This Folder**, and pick the account.
- New chats in that folder now use it. **Chats already running are not
  touched** — they finish on the account they started with. No reload.
- Route different folders to different accounts and they all run at the same
  time, each with its own history and its own login.

### Per-project pinning (optional)

Put a `.claude-profile` file containing a profile name in any project folder:

```
Work
```

That folder (and everything under it) uses the `Work` account, overriding
`map.conf`. Commit it to the repo if the whole team convention is yours alone;
otherwise gitignore it.

### Terminals / CLI

The same routing works for the `claude` CLI if your launcher sources the
helper (add once to `.bashrc` or a launcher script):

```bash
[ -f ~/.claude-profiles/_bin/profile-env.sh ] && . ~/.claude-profiles/_bin/profile-env.sh && claude_profile_apply
exec claude "$@"   # or just run `claude` after the two lines above
```

Or bypass routing explicitly for one command / one shell:

```bash
CLAUDE_PROFILE=Work claude          # one command on the Work account
export CLAUDE_PROFILE=Work          # whole shell on the Work account
```

Ongoing terminal sessions are processes too — starting a new one on another
account never disturbs them.

### Knowing which account you're on

- The **status bar** shows the account that new chats in the current folder
  will use: `👤 Claude: Work`.
- **Claude Accounts: Show Status** lists every account, its email, login
  state, and which folders route to it.
- `~/.claude-profiles/_bin/resolve.log` records the last few hundred routing
  decisions (folder → profile; never any secrets) if you want to verify.

## Migration from v0.x

On first activation v1.0 automatically:

- Detects v0.x snapshot profiles (`<profile>/.claude/…`).
- The profile that was **active** keeps living at `~/.claude` (that was always
  its real, current state). Its name becomes the default account's display
  label; its stale snapshot is archived under `_backups/`.
- Every **other** profile is converted in place into a live config dir — its
  stored login is preserved (login files are backed up under `_backups/`
  first). If the stored token already expired while it sat unused, one
  `/login` in its login terminal fixes it permanently.
- Names with spaces are renamed (`My Account` → `My-Account`), since v1 names
  travel through environment variables and the map file.

Old v0.x full backups remain usable via
**Claude Accounts: Restore Legacy (v0.x) Backup**.

## Commands (Command Palette)

| Command | What it does |
|---|---|
| Use Account for This Folder | Route new chats in a folder to an account (status-bar click does the same) |
| Add Account | Create a new always-logged-in profile and open its one-time login terminal |
| Open Login Terminal for Account | Re-open a login terminal (first login, or if a token expired unused) |
| Show Status | Every account: email, login state, routed folders, routing health |
| Backup All Logins | Snapshot every profile's login files into `_backups/` |
| Delete Account Profile | Remove a profile directory (takes a login snapshot first; the account itself is untouched) |
| Restore Legacy (v0.x) Backup | Disaster recovery for old swap-model backups |
| Disable Folder Routing | Clear the `claudeProcessWrapper` setting (logins are untouched) |
| Open Profiles Folder | Open/copy the profiles folder path |

## Recovery instructions

- **A profile lost its login?** Run **Open Login Terminal for Account** and
  `/login` once. Nothing else is affected.
- **Accidentally deleted a profile?** Every deletion is preceded by a login
  snapshot: copy `.credentials.json` and `.claude.json` from the newest
  `_backups/<timestamp>-logins/<name>/` back into a re-created profile folder.
- **Routing misbehaving?** Check `~/.claude-profiles/_bin/resolve.log`, or run
  **Disable Folder Routing** — everything falls back to the default account
  exactly as if the extension were not installed.
- **v0.x state needed back?** **Restore Legacy (v0.x) Backup** restores a full
  old snapshot into `~/.claude` (with a fresh safety backup first).

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeProfileSwitcher.profilesRoot` | `~/.claude-profiles` | Where profiles, routing and backups live |
| `claudeProfileSwitcher.activeClaudeDir` | `~/.claude` | Default account's config dir |
| `claudeProfileSwitcher.activeClaudeJson` | `~/.claude.json` | Default account's root JSON |
| `claudeProfileSwitcher.maxBackups` | `25` | Snapshots kept in `_backups` (oldest pruned; `0` = keep all) |

## Build from source

```bash
npm install
npm test          # compiles + runs the core test suite in a temp sandbox
npm run package   # produces account-switcher-for-claude-code-<version>.vsix
```

Install with: `code-server --install-extension account-switcher-for-claude-code-<version>.vsix`
(or VS Code: *Extensions: Install from VSIX…*).

## Support this project

This tool is free and open source. If it saves you time, you can
[**sponsor me on GitHub**](https://github.com/sponsors/FaisalSannan) or
[**buy me a coffee**](https://buymeacoffee.com/fsannan) — it keeps the
extension maintained as Claude Code evolves. Stars on the repo help others
find it too. ⭐

## Notes & limitations

- Routing needs a POSIX shell: Linux, macOS, code-server, or WSL. On plain
  Windows, set `CLAUDE_CONFIG_DIR` per environment manually (profiles still
  work — only the automatic per-folder routing needs the wrapper script).
- A chat keeps the account it was **started** with; switching affects new
  chats only (that's the feature — nothing running is ever interrupted).
- Each profile has its own workspace-trust state. New profiles copy your
  existing trust decisions and onboarding state (never credentials), so first
  runs skip the dialogs.
- Conversation history is per account by design. A folder's old conversations
  reappear when its routing points back at the account that created them.
- Usage limits, plans and rate limits are per account, as Anthropic defines
  them. This tool only manages where each account's files live; make sure your
  use of multiple accounts complies with Anthropic's terms of service.
