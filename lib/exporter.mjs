/**
 * @fileoverview Cross-platform Markdown exporter: collision-safe ~/Downloads writes and native OS Save As dialogs.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWorkspacePath } from 'antigravity-sidecar-kit/workspace';

export const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

const WIN_SAVE_DIALOG_PS1 = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$owner.Opacity = 0',
  '$owner.Width = 1',
  '$owner.Height = 1',
  "$owner.StartPosition = 'CenterScreen'",
  '$owner.Show()',
  '$owner.Activate()',
  'try {',
  '  $dlg = New-Object System.Windows.Forms.SaveFileDialog',
  "  $dlg.Title = 'Export Markdown'",
  "  $dlg.Filter = 'Markdown files (*.md)|*.md|All files (*.*)|*.*'",
  "  $dlg.DefaultExt = 'md'",
  '  $dlg.AddExtension = $true',
  '  $dlg.OverwritePrompt = $true',
  '  if ($env:NOTES_SAVE_DIR -and (Test-Path -LiteralPath $env:NOTES_SAVE_DIR)) {',
  '    $dlg.InitialDirectory = $env:NOTES_SAVE_DIR',
  '  }',
  '  $dlg.FileName = $env:NOTES_SAVE_NAME',
  '  $res = $dlg.ShowDialog($owner)',
  '  if ($res -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.FileName) {',
  '    [Console]::Out.Write($dlg.FileName)',
  '  }',
  '} finally {',
  '  $owner.Close()',
  '  $owner.Dispose()',
  '}',
].join('\n');

const MAC_SAVE_DIALOG_JXA = [
  "ObjC.import('stdlib');",
  'const app = Application.currentApplication();',
  'app.includeStandardAdditions = true;',
  "const dir = $.getenv('NOTES_SAVE_DIR') || '';",
  "const name = $.getenv('NOTES_SAVE_NAME') || 'notes.md';",
  'try {',
  '  const opts = { withPrompt: "Export Markdown", defaultName: name };',
  '  if (dir) { opts.defaultLocation = Path(dir); }',
  '  const chosen = app.chooseFileName(opts);',
  '  chosen ? chosen.toString() : "";',
  '} catch (e) {',
  '  if (e && e.errorNumber === -128) { ""; } else { throw e; }',
  '}',
].join('\n');

function clientError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function trimEdgeDotDash(str) {
  let start = 0;
  let end = str.length;
  const isDotOrDash = (ch) => ch === '.' || ch === '-';
  while (start < end && isDotOrDash(str[start])) start += 1;
  while (end > start && isDotOrDash(str[end - 1])) end -= 1;
  return str.slice(start, end);
}

export function sanitizeExportFilename(rawName) {
  const cleaned = trimEdgeDotDash(
    String(rawName || '')
      .trim()
      .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '-')
      .replace(/\.{2,}/g, '-')
  );
  const base = trimEdgeDotDash(cleaned.replace(/\s+/g, '-').replace(/-+/g, '-'));
  if (!base) {
    return 'notes.md';
  }
  const hasMdExt = /\.md$/i.test(base);
  const stem = (hasMdExt ? base.slice(0, -3) : base).slice(0, 120) || 'notes';
  return `${stem}.md`;
}

function defaultExecFile(cmd, args, opts) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        rejectPromise(err);
        return;
      }
      resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function isExistingDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') {
    return false;
  }
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function resolveInitialDir({ workspacePath, downloadsDir, homeDir }) {
  if (workspacePath && typeof workspacePath === 'string' && workspacePath.trim()) {
    const trimmed = workspacePath.trim();
    let decoded = trimmed;
    if (/^file:\/\//i.test(trimmed)) {
      const normalizedUri = trimmed.replace(/%3a/gi, ':');
      try {
        decoded = fileURLToPath(normalizedUri);
      } catch {
        decoded = normalizeWorkspacePath(normalizedUri);
      }
    }
    if (decoded) {
      const candidate = resolve(decoded);
      if (isExistingDir(candidate)) {
        return candidate;
      }
    }
  }
  if (isExistingDir(downloadsDir)) {
    return downloadsDir;
  }
  return isExistingDir(homeDir) ? homeDir : process.cwd();
}

async function writeUniqueFile(dirPath, safeName, content) {
  mkdirSync(dirPath, { recursive: true });
  const ext = extname(safeName) || '.md';
  const stem = safeName.slice(0, safeName.length - ext.length) || 'notes';
  let attempt = 1;
  while (attempt <= 500) {
    const candidateName = attempt === 1 ? `${stem}${ext}` : `${stem}-${attempt}${ext}`;
    const targetPath = join(dirPath, candidateName);
    try {
      await writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' });
      return targetPath;
    } catch (err) {
      if (err?.code === 'EEXIST') {
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
  throw clientError('Unable to allocate a unique export filename in Downloads.', 500);
}

async function pickNativeSavePath({ safeName, initialDir, platform, execFileFn, env }) {
  const childEnv = {
    ...env,
    NOTES_SAVE_DIR: initialDir,
    NOTES_SAVE_NAME: safeName,
  };
  if (platform === 'win32') {
    const { stdout } = await execFileFn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', WIN_SAVE_DIALOG_PS1],
      { env: childEnv, windowsHide: true, timeout: 300_000 }
    );
    return String(stdout || '').trim();
  }
  if (platform === 'darwin') {
    const { stdout } = await execFileFn(
      'osascript',
      ['-l', 'JavaScript', '-e', MAC_SAVE_DIALOG_JXA],
      { env: childEnv, timeout: 300_000 }
    );
    return String(stdout || '').trim();
  }
  const defaultTarget = join(initialDir, safeName);
  try {
    const { stdout } = await execFileFn(
      'zenity',
      ['--file-selection', '--save', '--confirm-overwrite', '--title=Export Markdown', `--filename=${defaultTarget}`],
      { env: childEnv, timeout: 300_000 }
    );
    return String(stdout || '').trim();
  } catch (err) {
    if (err?.code && err.code !== 'ENOENT') {
      return '';
    }
    if (!err?.code && typeof err?.status === 'number') {
      return '';
    }
    if (err?.code !== 'ENOENT') {
      return '';
    }
  }
  try {
    const { stdout } = await execFileFn(
      'kdialog',
      ['--getsavefilename', defaultTarget, '*.md|Markdown (*.md)'],
      { env: childEnv, timeout: 300_000 }
    );
    return String(stdout || '').trim();
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw clientError('No native file dialog utility (zenity/kdialog) available; use Save to Downloads instead.', 501);
    }
    return '';
  }
}

export function createExporter(options = {}) {
  const execFileFn = typeof options.execFileFn === 'function' ? options.execFileFn : defaultExecFile;
  const platform = options.platform || process.platform;
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const homeDir = options.homeDir || homedir();
  const downloadsDir = options.downloadsDir || join(homeDir, 'Downloads');

  async function exportMarkdown(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw clientError('Export payload must be an object.', 400);
    }
    if (typeof payload.content !== 'string') {
      throw clientError('Export content must be a string.', 400);
    }
    if (Buffer.byteLength(payload.content, 'utf8') > MAX_EXPORT_BYTES) {
      throw clientError(`Export content exceeds maximum size of ${MAX_EXPORT_BYTES} bytes.`, 400);
    }
    const mode = payload.mode === undefined ? 'downloads' : String(payload.mode);
    if (mode !== 'downloads' && mode !== 'save-as') {
      throw clientError(`Invalid export mode "${mode}". Expected "downloads" or "save-as".`, 400);
    }
    const safeName = sanitizeExportFilename(payload.filename);

    if (mode === 'downloads') {
      const savedPath = await writeUniqueFile(downloadsDir, safeName, payload.content);
      return {
        ok: true,
        mode,
        saved: true,
        cancelled: false,
        path: savedPath,
        filename: basename(savedPath),
      };
    }

    const initialDir = resolveInitialDir({
      workspacePath: payload.workspacePath,
      downloadsDir,
      homeDir,
    });
    const rawChosen = await pickNativeSavePath({
      safeName,
      initialDir,
      platform,
      execFileFn,
      env,
    });
    if (!rawChosen) {
      return {
        ok: true,
        mode,
        saved: false,
        cancelled: true,
        path: '',
        filename: safeName,
      };
    }
    const finalPath = extname(rawChosen) ? resolve(rawChosen) : resolve(`${rawChosen}.md`);
    const parentDir = dirname(finalPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    await writeFile(finalPath, payload.content, 'utf8');
    return {
      ok: true,
      mode,
      saved: true,
      cancelled: false,
      path: finalPath,
      filename: basename(finalPath),
    };
  }

  return { exportMarkdown };
}
