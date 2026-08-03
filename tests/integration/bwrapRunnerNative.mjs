#!/usr/bin/env node
// Mandatory native-image gate. This script intentionally has no skip path.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    BWRAP_RUNNER_ABI,
    inspectCurrentProcfs,
    resolveExecutableIdentity,
} from '../../bwrap-runner/lib/capability.mjs';
import {
    buildBwrapArgs,
    getSystemReadOnlyPaths,
    validateInput,
} from '../../bwrap-runner/lib/policy.mjs';

const executable = resolveExecutableIdentity('/usr/bin/bwrap');
const procfs = inspectCurrentProcfs();
assert.equal(procfs.ok, true, `outer proc identity invalid: ${JSON.stringify(procfs)}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-native-'));
const workDir = path.join(root, 'work');
const outputsDir = path.join(root, 'outputs');
const siblingDir = path.join(root, 'sibling');
fs.mkdirSync(workDir);
fs.mkdirSync(outputsDir);
fs.mkdirSync(siblingDir);

const existingSystemPaths = new Set(getSystemReadOnlyPaths().filter((candidate) => {
    try {
        fs.accessSync(candidate, fs.constants.R_OK);
        return true;
    } catch (_) {
        return false;
    }
}));

try {
    for (const procMode of ['private', 'empty']) {
        const validated = validateInput({
            command: [
                'printf allowed > /work/allowed.txt',
                'printf output > /outputs/result.txt',
                'test ! -e /sibling',
                'if printf denied > /sibling/denied.txt 2>/dev/null; then exit 91; fi',
                `printf native-${procMode}-ok`,
            ].join(' && '),
        });
        const args = buildBwrapArgs(validated, {
            workDir,
            outputsDir,
            existingSystemPaths,
            procMode,
        });
        const result = spawnSync(executable.realpath, args, {
            encoding: 'utf8',
            timeout: 15_000,
            env: {},
        });
        assert.ifError(result.error);
        assert.equal(
            result.status,
            0,
            `${procMode} policy failed: stdout=${result.stdout} stderr=${result.stderr}`,
        );
        assert.equal(result.stdout, `native-${procMode}-ok`);
        assert.equal(fs.readFileSync(path.join(workDir, 'allowed.txt'), 'utf8'), 'allowed');
        assert.equal(fs.readFileSync(path.join(outputsDir, 'result.txt'), 'utf8'), 'output');
        assert.equal(fs.existsSync(path.join(siblingDir, 'denied.txt')), false);
        fs.rmSync(path.join(workDir, 'allowed.txt'));
        fs.rmSync(path.join(outputsDir, 'result.txt'));
    }
    process.stdout.write(`${JSON.stringify({ ok: true, runnerAbi: BWRAP_RUNNER_ABI, modes: ['private', 'empty'] })}\n`);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
