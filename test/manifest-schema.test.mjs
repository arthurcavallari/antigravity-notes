import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintPluginOrSidecar, validateHubManifest, validateSidecarJson } from 'antigravity-sidecar-kit/validator';
import { validateRepoManifests } from '../scripts/validate-manifest.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));

describe('hub-manifest.json, sidecar.json & package-lock.json alignment', () => {
  it('validates shipped hub-manifest.json, sidecar.json, and strict sidecar lint cleanly', () => {
    const res = validateRepoManifests(REPO_ROOT);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
    assert.equal(res.valid, true);

    const hub = readJson('hub-manifest.json');
    assert.equal(hub.workspaceTriggers, undefined, 'TIER_3_AGENT_CONTROL sidecar must omit workspaceTriggers');

    const strictLint = lintPluginOrSidecar(REPO_ROOT, { strict: true });
    assert.deepEqual(strictLint.errors, []);
    assert.deepEqual(strictLint.warnings, []);
    assert.equal(strictLint.valid, true);
  });

  it('rejects manifests that would break or endanger installs', () => {
    const base = readJson('hub-manifest.json');
    const errorsFor = (overrides, opts = {}) =>
      validateHubManifest({ ...base, ...overrides }, opts)
        .errors.map((e) => e.message)
        .join('\n');

    assert.match(errorsFor({ id: '' }), /id/i);
    assert.match(errorsFor({ capabilityTier: 'TIER_0' }), /capabilityTier/i);
    assert.match(errorsFor({ version: '' }), /version/i);
    assert.match(errorsFor({}, { packageVersion: '9.9.9' }), /package\.json/i);
    assert.match(errorsFor({ workspaceTriggers: { files: ['*'] } }), /workspaceTriggers/i);
    assert.match(errorsFor({ workspaceTriggers: { files: ['../../.ssh/id_rsa'] } }), /workspaceTriggers/i);
    assert.match(errorsFor({ workspaceTriggers: { files: ['C:/Windows/win.ini'] } }), /workspaceTriggers/i);
    assert.match(errorsFor({ workspaceTriggers: { files: ['/etc/passwd'] } }), /workspaceTriggers/i);
    assert.match(
      validateSidecarJson({ args: ['launch.mjs'] }).errors.map((e) => e.message).join('\n'),
      /command/i
    );
    assert.match(
      validateSidecarJson({
        command: 'node',
        args: ['launch.mjs'],
        restart_policy: 'invalid-policy',
      })
        .errors.map((e) => e.message)
        .join('\n'),
      /restart_policy/i
    );
    assert.match(
      validateSidecarJson({
        command: 'node',
        args: ['launch.mjs'],
        ui_config: { views: [{ entrypoint: 'INVALID_ENTRYPOINT' }] },
      })
        .errors.map((e) => e.message)
        .join('\n'),
      /entrypoint/i
    );
  });

  it('keeps package.json, hub-manifest.json, and package-lock.json aligned and sidecar-kit >=1.9.0 with zero file: paths', () => {
    const pkgRaw = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
    const lockRaw = readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8');
    assert.doesNotMatch(pkgRaw, /"file:/i);
    assert.doesNotMatch(lockRaw, /"file:/i);

    const pkg = JSON.parse(pkgRaw);
    const hub = readJson('hub-manifest.json');
    const lock = JSON.parse(lockRaw);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.equal(hub.version, pkg.version);
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(pkg.dependencies['antigravity-sidecar-kit'], '^1.9.0');
    assert.equal(lock.packages?.['']?.version, pkg.version);
    assert.match(lock.packages?.['node_modules/antigravity-sidecar-kit']?.version || '', /^1\.9\./);
  });
});
