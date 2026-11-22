#!/usr/bin/env node
/**
 * @fileoverview Validates sidecar.json and hub-manifest.json using antigravity-sidecar-kit/validator.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJsonSafe } from 'antigravity-sidecar-kit/config';
import { validateHubManifest, validateSidecarJson } from 'antigravity-sidecar-kit/validator';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function validateRepoManifests(repoRoot = REPO_ROOT) {
  const pkg = readJsonSafe(join(repoRoot, 'package.json'), null);
  const sidecarJson = readJsonSafe(join(repoRoot, 'sidecar.json'), null);
  const hubManifest = readJsonSafe(join(repoRoot, 'hub-manifest.json'), null);

  const targetDir = existsSync(join(repoRoot, 'launch.mjs')) ? repoRoot : undefined;
  const sidecarResult = validateSidecarJson(sidecarJson, {
    targetDir,
    file: 'sidecar.json',
  });
  const hubResult = validateHubManifest(hubManifest, {
    packageVersion: typeof pkg?.version === 'string' ? pkg.version : undefined,
    file: 'hub-manifest.json',
  });

  const errors = [...sidecarResult.errors, ...hubResult.errors];
  const warnings = [...sidecarResult.warnings, ...hubResult.warnings];
  return {
    valid: errors.length === 0 && warnings.length === 0,
    errors,
    warnings,
    id: hubManifest?.id || '',
    version: hubManifest?.version || '',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = validateRepoManifests();
  for (const warn of result.warnings) {
    console.error(`[WARN] ${warn.file} (${warn.ruleId}): ${warn.message}`);
  }
  for (const err of result.errors) {
    console.error(`[ERROR] ${err.file} (${err.ruleId}): ${err.message}`);
  }
  if (!result.valid) {
    process.exit(1);
  }
  console.log(`sidecar.json and hub-manifest.json are valid (${result.id} ${result.version})`);
}
