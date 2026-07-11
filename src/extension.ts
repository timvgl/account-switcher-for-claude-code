import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as core from './core';

const WRAPPER_PROMPT_KEY = 'claudeProfileSwitcher.wrapperPromptDismissedV1';
const OFFICIAL_EXT_ID = 'anthropic.claude-code';
const OFFICIAL_WRAPPER_SETTING = 'claudeProcessWrapper';

let ctx: vscode.ExtensionContext;
let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let wrapperPath: string | undefined;

export function activate(context: vscode.ExtensionContext) {
  ctx = context;
  output = vscode.window.createOutputChannel('Claude Account Switcher');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  statusBar.command = 'claudeProfileSwitcher.useProfileHere';
  statusBar.tooltip = 'Account used by NEW Claude chats in this folder — click to change (running chats are never touched)';
  context.subscriptions.push(statusBar, output);

  const commands: Array<[string, () => Promise<void>]> = [
    ['claudeProfileSwitcher.useProfileHere', useProfileHere],
    ['claudeProfileSwitcher.switchProfile', useProfileHere], // v0.x command id, kept for muscle memory / keybindings
    ['claudeProfileSwitcher.addAccount', addAccount],
    ['claudeProfileSwitcher.loginProfile', loginProfile],
    ['claudeProfileSwitcher.showStatus', showStatus],
    ['claudeProfileSwitcher.openProfilesFolder', openProfilesFolder],
    ['claudeProfileSwitcher.deleteProfile', deleteProfile],
    ['claudeProfileSwitcher.backupLogins', backupLogins],
    ['claudeProfileSwitcher.restoreLegacyBackup', restoreLegacyBackup],
    ['claudeProfileSwitcher.disableRouting', disableRouting]
  ];
  for (const [id, fn] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, guard(fn)));
  }

  void (async () => {
    try {
      const p = paths();
      wrapperPath = await core.materializeHelperScripts(p, extensionVersion(), log);
      await runMigration();
      watchRoutingFiles();
      const orphans = await core.findSwapOrphans(p);
      if (orphans.length) {
        log(`swap orphans detected: ${orphans.join(', ')}`);
        vscode.window.showWarningMessage(
          `Claude Account Switcher: found leftover swap artifacts from an interrupted v0.x operation: ${orphans.join(', ')}. ` +
          'They may contain account state — inspect and rename/remove them manually.');
      }
      await maybeOfferRouting();
    } catch (err) {
      log(`activation error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await updateStatusBar();
  })();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => { void updateStatusBar(); })
  );
}

export function deactivate() { /* nothing to clean up */ }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guard(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`error: ${msg}`);
      vscode.window.showErrorMessage(`Claude Account Switcher: ${msg}`);
    } finally {
      await updateStatusBar();
    }
  };
}

function log(message: string) {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function cfg() { return vscode.workspace.getConfiguration('claudeProfileSwitcher'); }

function extensionVersion(): string {
  return (ctx.extension.packageJSON as { version?: string }).version ?? '0.0.0';
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function paths(): core.Paths {
  return {
    claudeDir: expandHome(cfg().get<string>('activeClaudeDir')?.trim() || path.join(os.homedir(), '.claude')),
    claudeJson: expandHome(cfg().get<string>('activeClaudeJson')?.trim() || path.join(os.homedir(), '.claude.json')),
    profilesRoot: expandHome(cfg().get<string>('profilesRoot')?.trim() || path.join(os.homedir(), '.claude-profiles'))
  };
}

function currentFolder(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { return undefined; }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const f = vscode.workspace.getWorkspaceFolder(active);
    if (f) { return f.uri.fsPath; }
  }
  return folders[0].uri.fsPath;
}

function profileDisplay(p: core.ProfileInfo): string {
  if (p.isDefault) {
    return p.label ? `${p.label} (default account)` : 'Default account';
  }
  return p.name;
}

async function updateStatusBar() {
  try {
    const p = paths();
    const folder = currentFolder();
    if (!folder) {
      statusBar.text = '$(account) Claude: default';
      statusBar.show();
      return;
    }
    const name = await core.resolveProfileForDir(p, folder, os.homedir());
    const label = name === core.DEFAULT_PROFILE
      ? (await core.getDefaultLabel(p)) ?? 'default'
      : name;
    statusBar.text = `$(account) Claude: ${label}`;
  } catch {
    statusBar.text = '$(account) Claude';
  }
  statusBar.show();
}

function watchRoutingFiles() {
  const root = paths().profilesRoot;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, '{map.conf,_default.label}'));
  for (const ev of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
    ctx.subscriptions.push(ev(() => { void updateStatusBar(); }));
  }
  ctx.subscriptions.push(watcher);
}

// ---------------------------------------------------------------------------
// Routing via the official extension's claudeProcessWrapper setting
// ---------------------------------------------------------------------------

function configuredWrapper(): string {
  return vscode.workspace.getConfiguration('claudeCode').get<string>(OFFICIAL_WRAPPER_SETTING)?.trim() ?? '';
}

/**
 * Make sure the official Claude extension launches new sessions through our
 * routing wrapper. Asks once; never overwrites a foreign wrapper.
 */
async function ensureRoutingConfigured(interactive: boolean): Promise<boolean> {
  if (!wrapperPath) {
    wrapperPath = await core.materializeHelperScripts(paths(), extensionVersion(), log);
  }
  const current = configuredWrapper();
  if (current === wrapperPath) { return true; }
  if (current) {
    vscode.window.showWarningMessage(
      `Claude Account Switcher: claudeCode.${OFFICIAL_WRAPPER_SETTING} is already set to '${current}'. ` +
      'Folder-based account routing is disabled to avoid clobbering it. Clear that setting to enable routing.');
    return false;
  }
  if (!interactive) { return false; }
  const pick = await vscode.window.showInformationMessage(
    'Enable per-folder account routing? This sets the official Claude extension\'s ' +
    `"claudeCode.${OFFICIAL_WRAPPER_SETTING}" setting to a small script that picks the right account ` +
    'for each NEW chat. Running chats are never touched, and no account is ever logged out.',
    { modal: true, detail: `Wrapper: ${wrapperPath}` },
    'Enable');
  if (pick !== 'Enable') { return false; }
  await vscode.workspace.getConfiguration('claudeCode')
    .update(OFFICIAL_WRAPPER_SETTING, wrapperPath, vscode.ConfigurationTarget.Global);
  log(`configured claudeCode.${OFFICIAL_WRAPPER_SETTING} -> ${wrapperPath}`);
  return true;
}

async function maybeOfferRouting() {
  if (configuredWrapper() || ctx.globalState.get<boolean>(WRAPPER_PROMPT_KEY)) { return; }
  const profiles = await core.listProfiles(paths());
  if (profiles.length <= 1) { return; } // nothing to route until a second account exists
  const pick = await vscode.window.showInformationMessage(
    'Claude Account Switcher v1 keeps every account logged in at once and routes each folder to an account. Enable routing?',
    'Enable', 'Not now');
  if (pick === 'Enable') {
    await ensureRoutingConfigured(true);
    await updateStatusBar();
  } else if (pick === 'Not now') {
    await ctx.globalState.update(WRAPPER_PROMPT_KEY, true);
  }
}

async function disableRouting() {
  const current = configuredWrapper();
  if (!current) {
    vscode.window.showInformationMessage('Folder-based account routing is not enabled.');
    return;
  }
  if (wrapperPath && current !== wrapperPath) {
    vscode.window.showWarningMessage(
      `claudeCode.${OFFICIAL_WRAPPER_SETTING} points to a wrapper this extension does not manage ('${current}'); leaving it alone.`);
    return;
  }
  await vscode.workspace.getConfiguration('claudeCode')
    .update(OFFICIAL_WRAPPER_SETTING, undefined, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    'Account routing disabled. New chats use the default account (~/.claude). ' +
    'No login was touched — re-enable any time by switching an account for a folder.');
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

async function runMigration() {
  const p = paths();
  const legacy = (await core.listProfiles(p)).filter(x => x.legacyLayout);
  const legacyActiveFile = path.join(p.profilesRoot, 'active-profile.json');
  const hasActiveFile = await fsp.access(legacyActiveFile).then(() => true, () => false);
  if (!legacy.length && !hasActiveFile) { return; }

  const report = await core.migrateToV2(p, log);
  const parts: string[] = [];
  if (report.becameDefault) {
    parts.push(`'${report.becameDefault}' was your live account — it stays exactly where it is (~/.claude) and is now shown as '${report.becameDefault} (default account)'.`);
  }
  if (report.migrated.length) {
    parts.push(`Converted to always-logged-in live profiles: ${report.migrated.join(', ')}. Their stored logins were preserved.`);
  }
  for (const r of report.renamed) { parts.push(`Renamed '${r.from}' → '${r.to}' (v1 names have no spaces).`); }
  parts.push(...report.warnings);
  if (parts.length) {
    log(`migration report: ${parts.join(' | ')}`);
    vscode.window.showInformationMessage(
      `Claude Account Switcher upgraded your profiles to the v1 "always logged in" model. ${parts.join(' ')}`);
  }
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

interface ProfilePick extends vscode.QuickPickItem { profile?: core.ProfileInfo; addNew?: boolean; }

async function pickProfile(title: string, opts?: { allowAdd?: boolean; excludeDefault?: boolean }): Promise<ProfilePick | undefined> {
  const p = paths();
  const profiles = await core.listProfiles(p);
  const items: ProfilePick[] = profiles
    .filter(pr => !(opts?.excludeDefault && pr.isDefault))
    .map(pr => ({
      label: profileDisplay(pr),
      description: pr.email ?? '',
      detail: pr.legacyLayout ? 'Legacy layout — will be migrated'
        : pr.loggedIn ? undefined : 'Not logged in yet — a login terminal will open when routed to.',
      profile: pr
    }));
  if (opts?.allowAdd) {
    items.push({ label: '$(add) Add another account…', addNew: true });
  }
  return vscode.window.showQuickPick(items, { title });
}

async function pickFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    vscode.window.showErrorMessage('Open a folder first — accounts are routed per folder.');
    return undefined;
  }
  if (folders.length === 1) { return folders[0].uri.fsPath; }
  const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to route to an account' });
  return picked?.uri.fsPath;
}

// ---------------------------------------------------------------------------
// Login terminals
// ---------------------------------------------------------------------------

async function officialClaudeBinary(): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension(OFFICIAL_EXT_ID);
  if (!ext) { return undefined; }
  const candidate = path.join(ext.extensionPath, 'resources', 'native-binary', 'claude');
  try { await fsp.access(candidate); return candidate; } catch { return undefined; }
}

async function openLoginTerminal(profile: core.ProfileInfo) {
  const bin = await officialClaudeBinary();
  const term = vscode.window.createTerminal({
    name: `Claude login — ${profile.name}`,
    env: { CLAUDE_CONFIG_DIR: profile.dir }
  });
  term.show();
  term.sendText(bin ? `"${bin}"` : 'claude');
  vscode.window.showInformationMessage(
    `A terminal opened for '${profile.name}'. Complete the login there (type /login if not prompted). ` +
    'The login is stored only inside that profile, survives reboots, and never signs any other account out.');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function useProfileHere() {
  const folder = await pickFolder();
  if (!folder) { return; }
  const p = paths();
  const picked = await pickProfile(`Account for new Claude chats in ${path.basename(folder)}`, { allowAdd: true });
  if (!picked) { return; }
  if (picked.addNew) { await addAccount(); return; }
  const target = picked.profile!;

  await core.setMapping(p, folder, target.isDefault ? core.DEFAULT_PROFILE : target.name);
  const routed = await ensureRoutingConfigured(true);

  const display = profileDisplay(target);
  if (routed) {
    vscode.window.showInformationMessage(
      `New Claude chats in '${path.basename(folder)}' now use ${display}. ` +
      'Chats that are already running keep their account and are not interrupted — just open a NEW chat. No reload needed.');
  }
  if (!target.isDefault && !target.loggedIn) {
    await openLoginTerminal(target);
  }
}

async function addAccount() {
  const input = await vscode.window.showInputBox({
    title: 'Add Claude account',
    prompt: 'Name for the new account profile (e.g. Work, Personal, Client-X)',
    validateInput: v => {
      const cleaned = core.cleanProfileName(v);
      if (!cleaned) { return 'Enter a name (letters, digits, dot, dash, underscore).'; }
      if (!core.isValidProfileName(cleaned)) { return 'Names must not start with "_" or "." , must not be "default", max 64 chars, no spaces.'; }
      return undefined;
    }
  });
  if (!input) { return; }
  const name = core.cleanProfileName(input);
  const p = paths();
  const info = await core.createProfile(p, name, {}, log);
  log(`created profile '${info.name}'`);

  const folder = currentFolder();
  const buttons = folder ? ['Log in now', 'Log in + use in this folder'] : ['Log in now'];
  const pick = await vscode.window.showInformationMessage(
    `Profile '${info.name}' created. It needs one login with the account you want; after that it stays logged in — across switches, reboots and shutdowns.`,
    ...buttons);
  if (pick === 'Log in + use in this folder' && folder) {
    await core.setMapping(p, folder, info.name);
    await ensureRoutingConfigured(true);
  }
  if (pick) { await openLoginTerminal(info); }
}

async function loginProfile() {
  const picked = await pickProfile('Open a login terminal for which account?', { excludeDefault: true });
  if (!picked?.profile) { return; }
  await openLoginTerminal(picked.profile);
}

async function showStatus() {
  const p = paths();
  const profiles = await core.listProfiles(p);
  const map = await core.listMap(p);
  const routing = configuredWrapper()
    ? (configuredWrapper() === wrapperPath ? 'enabled' : `foreign wrapper: ${configuredWrapper()}`)
    : 'not enabled';

  const lines: string[] = [`Folder routing: ${routing}`, ''];
  for (const pr of profiles) {
    const mapped = map.filter(m => pr.isDefault ? false : m.profile === pr.name).map(m => m.prefix);
    lines.push([
      `● ${profileDisplay(pr)}`,
      pr.email ? `  ${pr.email}` : undefined,
      `  ${pr.loggedIn ? 'logged in' : 'NOT logged in'}${pr.legacyLayout ? ' · legacy layout' : ''}`,
      mapped.length ? `  folders: ${mapped.join(', ')}` : undefined
    ].filter(Boolean).join('\n'));
  }
  lines.push('', `Profiles folder: ${p.profilesRoot}`, `Default account: ${p.claudeDir}`);
  log(lines.join(' | '));
  vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}

async function openProfilesFolder() {
  const p = paths();
  const pick = await vscode.window.showInformationMessage(
    `Profiles folder: ${p.profilesRoot}`, 'Open in New Window', 'Copy Path');
  if (pick === 'Open in New Window') {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.profilesRoot), { forceNewWindow: true });
  } else if (pick === 'Copy Path') {
    await vscode.env.clipboard.writeText(p.profilesRoot);
  }
}

async function deleteProfile() {
  const picked = await pickProfile('Delete which account profile?', { excludeDefault: true });
  if (!picked?.profile) { return; }
  const target = picked.profile;
  const confirm = await vscode.window.showWarningMessage(
    `Delete profile '${target.name}' from this machine? Its stored login and session history are removed and any folders routed to it fall back to the default account. The account itself is untouched — you can add it again and log in any time.`,
    { modal: true }, 'Delete');
  if (confirm !== 'Delete') { return; }
  await core.backupLogins(paths(), log); // one last login snapshot before it goes
  await core.deleteProfile(paths(), target.name);
  vscode.window.showInformationMessage(`Deleted profile '${target.name}'.`);
}

async function backupLogins() {
  const info = await core.backupLogins(paths(), log);
  await core.pruneBackups(paths(), cfg().get<number>('maxBackups') ?? 25, log);
  vscode.window.showInformationMessage(`Login snapshot saved: ${info.dir}`);
}

async function restoreLegacyBackup() {
  const p = paths();
  const backups = await core.listBackups(p);
  const restorable: core.BackupInfo[] = [];
  for (const b of backups) {
    // Only FULL v0.x backups qualify; migrate-*/logins snapshots hold login
    // files only and restoring them would wipe the live ~/.claude.
    const hasDir = await fsp.access(path.join(b.dir, '.claude')).then(() => true, () => false);
    if (hasDir) { restorable.push(b); }
  }
  if (!restorable.length) {
    vscode.window.showErrorMessage('No restorable v0.x backups found.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    restorable.reverse().map(b => ({
      label: path.basename(b.dir),
      description: b.reason,
      detail: b.createdAt,
      backup: b
    })),
    { title: 'Restore a v0.x backup into the DEFAULT account (~/.claude)' });
  if (!picked) { return; }
  const confirm = await vscode.window.showWarningMessage(
    `Replace the live default account state (~/.claude) with backup '${path.basename(picked.backup.dir)}'? ` +
    'A pre-restore safety backup is taken first. Other profiles are not touched. ' +
    'Running chats on the default account should be closed first.',
    { modal: true }, 'Restore');
  if (confirm !== 'Restore') { return; }
  await core.restoreBackup(p, picked.backup, log);
  vscode.window.showInformationMessage('Backup restored into the default account. Open a new chat to use it.');
}
