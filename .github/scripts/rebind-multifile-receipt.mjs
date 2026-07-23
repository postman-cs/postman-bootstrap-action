#!/usr/bin/env node
/* global process, structuredClone */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseOnlySourceDrift,
  validateMultifileSpecSyncReceipt
} from '../../scripts/probe-multifile-spec-sync.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const RECEIPT_PATH = path.join(REPO_ROOT, 'validation/evidence/multifile-spec-sync.json');

function evidencePayload(receipt) {
  const evidence = structuredClone(receipt);
  delete evidence.bootstrapCommit;
  return evidence;
}

export function planMultifileReceiptRebind(receipt, options) {
  const validated = validateMultifileSpecSyncReceipt(receipt);
  const headCommit = String(options?.headCommit || '');
  if (!/^[a-f0-9]{40}$/.test(headCommit)) {
    throw new Error('headCommit must be a 40-char lowercase git sha');
  }
  if (validated.bootstrapCommit === headCommit) {
    return { updated: false, receipt: validated };
  }
  if (!options?.isAncestor?.(validated.bootstrapCommit, headCommit)) {
    throw new Error(
      `receipt.bootstrapCommit ${validated.bootstrapCommit} is not an ancestor of HEAD ${headCommit}`
    );
  }

  try {
    assertReleaseOnlySourceDrift(options.changedPaths || []);
    return { updated: false, receipt: validated };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('behavior-bearing paths changed')) {
      throw error;
    }
  }

  const rebound = validateMultifileSpecSyncReceipt({
    ...validated,
    bootstrapCommit: headCommit
  });
  if (JSON.stringify(evidencePayload(rebound)) !== JSON.stringify(evidencePayload(validated))) {
    throw new Error('receipt rebind changed live evidence fields');
  }
  return { updated: true, receipt: rebound };
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function main() {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_EVENT_NAME !== 'pull_request' ||
    process.argv[2] !== '--write'
  ) {
    throw new Error('receipt rebind write mode is restricted to pull-request GitHub Actions');
  }

  const headCommit = git(['rev-parse', 'HEAD']);
  if (process.env.EXPECTED_HEAD_SHA && process.env.EXPECTED_HEAD_SHA !== headCommit) {
    throw new Error(`checked-out HEAD ${headCommit} does not match expected PR head`);
  }
  const receipt = JSON.parse(readFileSync(RECEIPT_PATH, 'utf8'));
  const plan = planMultifileReceiptRebind(receipt, {
    headCommit,
    isAncestor: (ancestor, descendant) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
          cwd: REPO_ROOT,
          stdio: 'ignore'
        });
        return true;
      } catch {
        return false;
      }
    },
    changedPaths: git(['diff', '--name-only', `${receipt.bootstrapCommit}..${headCommit}`])
      .split('\n')
      .filter(Boolean)
  });

  if (plan.updated) {
    writeFileSync(RECEIPT_PATH, `${JSON.stringify(plan.receipt, null, 2)}\n`);
  }
  setOutput('updated', String(plan.updated));
  setOutput('source_sha', headCommit);
  process.stdout.write(
    plan.updated
      ? `Rebound multifile receipt to ${headCommit}; live evidence fields are unchanged.\n`
      : 'Multifile receipt already covers this source revision.\n'
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
