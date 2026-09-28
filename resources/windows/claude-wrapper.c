/*
 * Native Windows process launcher for Account Switcher for Claude Code.
 * The Claude VS Code extension requires claudeProcessWrapper to be an .exe.
 * This program mirrors the POSIX helper's routing and then starts argv[1].
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <wchar.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PATH_CAP 32768

static void trim(wchar_t *s) {
  wchar_t *start = s, *end;
  while (*start == L' ' || *start == L'\t' || *start == L'\r') { start++; }
  if (start != s) { memmove(s, start, (wcslen(start) + 1) * sizeof(*s)); }
  end = s + wcslen(s);
  while (end > s && (end[-1] == L' ' || end[-1] == L'\t' || end[-1] == L'\r')) { *--end = L'\0'; }
}

static void normalize_path(wchar_t *s) {
  size_t n;
  for (n = 0; s[n]; n++) { if (s[n] == L'/') { s[n] = L'\\'; } }
  n = wcslen(s);
  while (n > 3 && s[n - 1] == L'\\') { s[--n] = L'\0'; }
}

static void remove_leaf(wchar_t *s) {
  wchar_t *slash = wcsrchr(s, L'\\');
  if (!slash) { return; }
  if (slash == s + 2 && s[1] == L':') { slash[1] = L'\0'; return; }
  *slash = L'\0';
}

static int is_directory(const wchar_t *file) {
  DWORD attrs = GetFileAttributesW(file);
  return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY);
}

static int read_utf8(const wchar_t *file, wchar_t **out) {
  HANDLE h = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
  LARGE_INTEGER size;
  DWORD read = 0;
  char *bytes;
  int chars;
  if (h == INVALID_HANDLE_VALUE || !GetFileSizeEx(h, &size) || size.QuadPart > 1024 * 1024) {
    if (h != INVALID_HANDLE_VALUE) { CloseHandle(h); }
    return 0;
  }
  bytes = (char *)malloc((size_t)size.QuadPart + 1);
  if (!bytes || !ReadFile(h, bytes, (DWORD)size.QuadPart, &read, NULL)) { free(bytes); CloseHandle(h); return 0; }
  CloseHandle(h);
  bytes[read] = '\0';
  chars = MultiByteToWideChar(CP_UTF8, 0, bytes, (int)read, NULL, 0);
  if (!chars) { free(bytes); return 0; }
  *out = (wchar_t *)malloc(((size_t)chars + 1) * sizeof(wchar_t));
  if (!*out) { free(bytes); return 0; }
  MultiByteToWideChar(CP_UTF8, 0, bytes, (int)read, *out, chars);
  (*out)[chars] = L'\0';
  free(bytes);
  return 1;
}

static int read_first_line(const wchar_t *file, wchar_t *out, size_t cap) {
  wchar_t *text, *end;
  if (!read_utf8(file, &text)) { return 0; }
  end = wcspbrk(text, L"\r\n");
  if (end) { *end = L'\0'; }
  trim(text);
  wcsncpy(out, text, cap - 1);
  out[cap - 1] = L'\0';
  free(text);
  return out[0] != L'\0';
}

static int is_default_name(const wchar_t *name, const wchar_t *label) {
  return _wcsicmp(name, L"default") == 0 || (label[0] && wcscmp(name, label) == 0);
}

static int is_prefix(const wchar_t *target, const wchar_t *prefix) {
  size_t n = wcslen(prefix);
  return _wcsnicmp(target, prefix, n) == 0 && (target[n] == L'\0' || target[n] == L'\\');
}

static void append_path(wchar_t *out, size_t cap, const wchar_t *base, const wchar_t *leaf) {
  _snwprintf(out, cap, L"%ls\\%ls", base, leaf);
  out[cap - 1] = L'\0';
}

static void map_profile(const wchar_t *map, const wchar_t *cwd, wchar_t *name, size_t cap) {
  wchar_t *text, *line, *next, *best = NULL;
  size_t best_length = 0;
  if (!read_utf8(map, &text)) { return; }
  line = text;
  while (line && *line) {
    wchar_t *sep, *prefix, *profile;
    next = wcspbrk(line, L"\r\n");
    if (next) { *next++ = L'\0'; if (*next == L'\n') { next++; } }
    trim(line);
    if (*line && *line != L'#' && (sep = wcschr(line, L'|')) != NULL) {
      *sep = L'\0'; prefix = line; profile = sep + 1;
      trim(prefix); trim(profile); normalize_path(prefix);
      if (*prefix && *profile && is_prefix(cwd, prefix) && wcslen(prefix) > best_length) {
        best = profile; best_length = wcslen(prefix);
      }
    }
    line = next;
  }
  if (best) { wcsncpy(name, best, cap - 1); name[cap - 1] = L'\0'; }
  free(text);
}

static void resolve_profile_root(wchar_t *root, size_t cap) {
  DWORD len = GetModuleFileNameW(NULL, root, (DWORD)cap);
  if (!len || len >= cap) { root[0] = L'\0'; return; }
  remove_leaf(root); /* _bin */
  remove_leaf(root); /* .claude-profiles */
}

static void apply_profile(void) {
  wchar_t root[PATH_CAP], cwd[PATH_CAP], target[PATH_CAP], home[PATH_CAP], file[PATH_CAP], label[256] = L"", name[256] = L"";
  DWORD size;
  if (GetEnvironmentVariableW(L"CLAUDE_CONFIG_DIR", file, PATH_CAP) > 0) { return; }
  resolve_profile_root(root, PATH_CAP);
  if (!root[0] || !GetCurrentDirectoryW(PATH_CAP, cwd)) { return; }
  normalize_path(cwd);
  wcscpy(target, cwd);
  append_path(file, PATH_CAP, root, L"_default.label");
  read_first_line(file, label, sizeof(label) / sizeof(*label));

  size = GetEnvironmentVariableW(L"CLAUDE_PROFILE", name, (DWORD)(sizeof(name) / sizeof(*name)));
  if (!size) {
    GetEnvironmentVariableW(L"USERPROFILE", home, PATH_CAP);
    normalize_path(home);
    for (;;) {
      append_path(file, PATH_CAP, cwd, L".claude-profile");
      if (read_first_line(file, name, sizeof(name) / sizeof(*name))) { break; }
      if ((home[0] && _wcsicmp(cwd, home) == 0) || wcscmp(cwd, L"\\") == 0) { break; }
      { wchar_t previous[PATH_CAP]; wcscpy(previous, cwd); remove_leaf(cwd); if (wcscmp(previous, cwd) == 0) { break; } }
    }
    if (!name[0]) { append_path(file, PATH_CAP, root, L"map.conf"); map_profile(file, target, name, sizeof(name) / sizeof(*name)); }
  }
  if (!name[0] || is_default_name(name, label)) { return; }
  append_path(file, PATH_CAP, root, name);
  if (is_directory(file)) { SetEnvironmentVariableW(L"CLAUDE_CONFIG_DIR", file); }
  else { fwprintf(stderr, L"claude-profiles: unknown profile '%ls'; using default account\n", name); }
}

static void append_quoted(wchar_t **cursor, const wchar_t *arg) {
  wchar_t *out = *cursor;
  int slashes = 0;
  *out++ = L'"';
  while (*arg) {
    if (*arg == L'\\') { slashes++; *out++ = *arg++; continue; }
    if (*arg == L'"') { while (slashes--) { *out++ = L'\\'; } *out++ = L'\\'; *out++ = *arg++; slashes = 0; continue; }
    slashes = 0; *out++ = *arg++;
  }
  while (slashes--) { *out++ = L'\\'; }
  *out++ = L'"'; *out++ = L' ';
  *cursor = out;
}

int wmain(int argc, wchar_t **argv) {
  STARTUPINFOW si = { sizeof(si) };
  PROCESS_INFORMATION pi = { 0 };
  wchar_t *command, *cursor;
  size_t total = 2;
  int i;
  DWORD code;
  if (argc < 2 || GetFileAttributesW(argv[1]) == INVALID_FILE_ATTRIBUTES) {
    fwprintf(stderr, L"claude-wrapper: expected the Claude binary as first argument\n");
    return 127;
  }
  apply_profile();
  for (i = 1; i < argc; i++) { total += wcslen(argv[i]) * 2 + 4; }
  command = (wchar_t *)calloc(total, sizeof(wchar_t));
  if (!command) { return 127; }
  cursor = command;
  for (i = 1; i < argc; i++) { append_quoted(&cursor, argv[i]); }
  if (!CreateProcessW(argv[1], command, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
    fwprintf(stderr, L"claude-wrapper: failed to start Claude (error %lu)\n", GetLastError()); free(command); return 127;
  }
  free(command);
  WaitForSingleObject(pi.hProcess, INFINITE);
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  return (int)code;
}
