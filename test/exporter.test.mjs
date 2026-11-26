import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createExporter, sanitizeExportFilename } from '../lib/exporter.mjs';

describe('sanitizeExportFilename', () => {
  it('strips traversal characters, illegal path chars, and guarantees a .md suffix', () => {
    assert.equal(sanitizeExportFilename('hello.md'), 'hello.md');
    assert.equal(sanitizeExportFilename('My Notes: Draft?'), 'My-Notes-Draft.md');
    assert.equal(sanitizeExportFilename('../../etc/passwd'), 'etc-passwd.md');
    assert.equal(sanitizeExportFilename('   '), 'notes.md');
  });
});

describe('createExporter — Downloads & cross-platform native Save As', () => {
  it('writes collision-safe files into Downloads without overwriting existing files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notes-export-dl-'));
    try {
      const downloadsDir = join(root, 'Downloads');
      const exporter = createExporter({ downloadsDir, homeDir: root });

      const first = await exporter.exportMarkdown({ filename: 'hello.md', content: '# One\n', mode: 'downloads' });
      assert.equal(first.saved, true);
      assert.equal(first.cancelled, false);
      assert.equal(first.filename, 'hello.md');
      assert.equal(readFileSync(first.path, 'utf8'), '# One\n');

      const second = await exporter.exportMarkdown({ filename: 'hello.md', content: '# Two\n', mode: 'downloads' });
      assert.equal(second.filename, 'hello-2.md');
      assert.equal(readFileSync(second.path, 'utf8'), '# Two\n');
      assert.equal(readFileSync(first.path, 'utf8'), '# One\n', 'Must not overwrite first file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invokes PowerShell SaveFileDialog with env-bound initial directory on win32 and handles Save + Cancel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notes-export-win-'));
    try {
      const workspaceDir = join(root, 'my-project');
      const chosenTarget = join(root, 'picked', 'custom-note');
      mkdirSync(workspaceDir, { recursive: true });
      const calls = [];
      let shouldCancel = false;

      const exporter = createExporter({
        platform: 'win32',
        homeDir: root,
        downloadsDir: join(root, 'Downloads'),
        execFileFn: async (cmd, args, opts) => {
          calls.push({ cmd, args, env: opts.env });
          return { stdout: shouldCancel ? '' : chosenTarget, stderr: '' };
        },
      });

      const saved = await exporter.exportMarkdown({
        filename: 'hello.md',
        content: '# Saved via Save As\n',
        mode: 'save-as',
        workspacePath: workspaceDir,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'powershell.exe');
      assert.equal(calls[0].args.includes('-STA'), true);
      assert.equal(calls[0].env.NOTES_SAVE_DIR, workspaceDir);
      assert.equal(calls[0].env.NOTES_SAVE_NAME, 'hello.md');
      assert.equal(saved.saved, true);
      assert.equal(saved.cancelled, false);
      assert.equal(saved.filename, 'custom-note.md');
      assert.equal(readFileSync(saved.path, 'utf8'), '# Saved via Save As\n');

      shouldCancel = true;
      const cancelled = await exporter.exportMarkdown({
        filename: 'hello.md',
        content: '# Ignored\n',
        mode: 'save-as',
      });
      assert.equal(cancelled.saved, false);
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.path, '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports macOS JXA chooseFileName and Linux zenity -> kdialog -> 501 fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notes-export-unix-'));
    try {
      const macTarget = join(root, 'mac-export.md');
      const macExporter = createExporter({
        platform: 'darwin',
        homeDir: root,
        execFileFn: async (cmd) => {
          assert.equal(cmd, 'osascript');
          return { stdout: `${macTarget}\n`, stderr: '' };
        },
      });
      const macRes = await macExporter.exportMarkdown({ filename: 'pad.md', content: 'macOS body', mode: 'save-as' });
      assert.equal(macRes.saved, true);
      assert.equal(readFileSync(macRes.path, 'utf8'), 'macOS body');

      const linuxExporterKde = createExporter({
        platform: 'linux',
        homeDir: root,
        execFileFn: async (cmd) => {
          if (cmd === 'zenity') {
            const err = new Error('not found');
            err.code = 'ENOENT';
            throw err;
          }
          assert.equal(cmd, 'kdialog');
          return { stdout: join(root, 'kde-export.md'), stderr: '' };
        },
      });
      const kdeRes = await linuxExporterKde.exportMarkdown({ filename: 'pad.md', content: 'KDE body', mode: 'save-as' });
      assert.equal(kdeRes.saved, true);
      assert.equal(readFileSync(kdeRes.path, 'utf8'), 'KDE body');

      const linuxHeadless = createExporter({
        platform: 'linux',
        homeDir: root,
        execFileFn: async () => {
          const err = new Error('missing');
          err.code = 'ENOENT';
          throw err;
        },
      });
      await assert.rejects(
        linuxHeadless.exportMarkdown({ filename: 'pad.md', content: 'body', mode: 'save-as' }),
        (err) => err.statusCode === 501
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid export payloads with statusCode=400', async () => {
    const exporter = createExporter();
    await assert.rejects(exporter.exportMarkdown({ filename: 'a.md', content: 123 }), (e) => e.statusCode === 400);
    await assert.rejects(exporter.exportMarkdown({ filename: 'a.md', content: 'ok', mode: 'ftp' }), (e) => e.statusCode === 400);
  });

  it('decodes percent-encoded and POSIX file:/// workspacePath URIs into NOTES_SAVE_DIR', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notes-export-uri-'));
    try {
      const spacedWorkspace = join(root, 'My Spaced Project');
      const downloadsDir = join(root, 'Downloads');
      mkdirSync(spacedWorkspace, { recursive: true });
      mkdirSync(downloadsDir, { recursive: true });

      const encodedUri = pathToFileURL(spacedWorkspace).href.replace(/^file:\/\/\/([A-Za-z]):/, 'file:///$1%3A');
      let seenSaveDir = '';
      const exporter = createExporter({
        platform: 'darwin',
        homeDir: root,
        downloadsDir,
        execFileFn: async (_cmd, _args, opts) => {
          seenSaveDir = opts.env.NOTES_SAVE_DIR;
          return { stdout: '', stderr: '' };
        },
      });

      const res = await exporter.exportMarkdown({
        filename: 'draft.md',
        content: '# Draft\n',
        mode: 'save-as',
        workspacePath: encodedUri,
      });
      assert.equal(res.cancelled, true);
      assert.equal(seenSaveDir.toLowerCase(), spacedWorkspace.toLowerCase());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
