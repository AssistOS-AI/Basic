#!/usr/bin/env node
// Mandatory native-image gate. This script intentionally has no skip path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    BWRAP_CAPABILITY_ERROR_CODE,
    BWRAP_RUNNER_ABI,
    inspectCurrentProcfs,
    resolveBwrapCapability,
    resolveExecutableIdentity,
} from '../../bwrap-runner/lib/capability.mjs';
import { buildBwrapArgs, getSystemReadOnlyPaths, validateInput } from '../../bwrap-runner/lib/policy.mjs';
import { stageSystemFiles } from '../../bwrap-runner/lib/system-files.mjs';

const executable = resolveExecutableIdentity('/usr/bin/bwrap');
const procfs = inspectCurrentProcfs();
assert.equal(procfs.ok, true, `outer proc identity invalid: ${JSON.stringify(procfs)}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-native-'));
const workDir = path.join(root, 'work');
const outputsDir = path.join(root, 'outputs');
const siblingDir = path.join(root, 'sibling');
for (const dir of [workDir, outputsDir, siblingDir]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(siblingDir, 'secret'), 'must remain outside sandbox');
const existingSystemPaths = new Set(getSystemReadOnlyPaths().filter((candidate) => {
    try { fs.accessSync(candidate, fs.constants.R_OK); return true; } catch (_) { return false; }
}));
const systemFiles = stageSystemFiles({ temporaryRoot: root });
const originalFiles = new Map([...systemFiles.sources.keys()].map((name) => [name, fs.readFileSync(name)]));
const evidence = {};

function runMode(procMode) {
    const validated = validateInput({ command: [
        'printf allowed > /work/allowed.txt',
        'printf output > /outputs/result.txt',
        'test -z "${BWRAP_NATIVE_SECRET-}"',
        `test ! -e '${siblingDir}' && test ! -e '${systemFiles.directory}'`,
        'test ! -e /source && test ! -e /code && test ! -e /sibling',
        'if (printf denied > /sibling/denied.txt) 2>/dev/null; then exit 91; fi',
        'if (printf denied > /usr/bwrap-native-denied) 2>/dev/null; then exit 92; fi',
        ...[...systemFiles.sources.keys()].map((name) =>
            `test -r ${name} && if (printf denied > ${name}) 2>/dev/null; then exit 93; fi`),
        'test "$(ls -A /dev | tr "\\n" " ")" = "null random urandom zero "',
        'for device in null zero random urandom; do test -c /dev/$device && head -c 1 /dev/$device >/dev/null || exit 94; done',
        procMode === 'empty' ? 'test -z "$(ls -A /proc)"' : 'test -r /proc/self/status',
        `printf native-${procMode}-ok`,
    ].join(' && ') });
    const args = buildBwrapArgs(validated, {
        workDir, outputsDir, existingSystemPaths, systemFileSources: systemFiles.sources, procMode,
    });
    const result = spawnSync(executable.realpath, args, {
        encoding: 'utf8', timeout: 15_000, env: { BWRAP_NATIVE_SECRET: 'must-not-leak' },
    });
    assert.ifError(result.error);
    return result;
}

function assertExecuted(procMode, result) {
    assert.equal(result.status, 0, `${procMode} policy failed: stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.stdout, `native-${procMode}-ok`);
    assert.equal(fs.readFileSync(path.join(workDir, 'allowed.txt'), 'utf8'), 'allowed');
    assert.equal(fs.readFileSync(path.join(outputsDir, 'result.txt'), 'utf8'), 'output');
    assert.equal(fs.readFileSync(path.join(siblingDir, 'secret'), 'utf8'), 'must remain outside sandbox');
    assert.equal(fs.existsSync(path.join(siblingDir, 'denied.txt')), false);
    for (const [name, bytes] of originalFiles) assert.deepEqual(fs.readFileSync(name), bytes);
    fs.rmSync(path.join(workDir, 'allowed.txt'));
    fs.rmSync(path.join(outputsDir, 'result.txt'));
}

try {
    // Empty proc is a required, actually executed capability on every platform.
    const empty = runMode('empty');
    assertExecuted('empty', empty);
    evidence.empty = { executed: true, status: empty.status, boundaries: true };
    const selected = resolveBwrapCapability();
    const privateResult = runMode('private');
    if (privateResult.status === 0) {
        assertExecuted('private', privateResult);
        assert.equal(selected.mode, 'private');
        assert.equal(resolveBwrapCapability({ minimum: 'private' }).mode, 'private');
        evidence.private = { executed: true, status: 0, boundaries: true };
    } else {
        // A nonzero child alone is not unavailability evidence. The canonical
        // resolver must prove empty proc and reject the private-only minimum.
        assert.equal(selected.mode, 'empty');
        let unavailable;
        assert.throws(() => resolveBwrapCapability({ minimum: 'private' }), (error) => {
            unavailable = error;
            return error.code === BWRAP_CAPABILITY_ERROR_CODE && error.terminal === true
                && error.capability.runnerAbi === 2 && error.capability.minimum === 'private'
                && error.capability.availableMode === 'empty'
                && error.capability.diagnostics.find((probe) => probe.mode === 'private')?.ok === false
                && error.capability.diagnostics.find((probe) => probe.mode === 'empty')?.ok === true;
        });
        assert.equal(fs.existsSync(path.join(workDir, 'allowed.txt')), false);
        assert.equal(fs.existsSync(path.join(outputsDir, 'result.txt')), false);
        const stateRoot = path.join(root, 'private-must-not-create-state');
        const rejected = spawnSync('/usr/local/bin/bwrap-sandbox-exec', ['--minimum=private'], {
            encoding: 'utf8', timeout: 30_000,
            input: JSON.stringify({ command: 'printf must-not-run', files: [{ path: 'must-not-stage', content: 'no' }] }),
            env: { BWRAP_RUNNER_STATE: stateRoot },
        });
        assert.ifError(rejected.error);
        assert.equal(rejected.status, 1);
        const payload = JSON.parse(rejected.stdout);
        assert.equal(payload.ok, false);
        assert.equal(payload.error.code, BWRAP_CAPABILITY_ERROR_CODE);
        assert.equal(payload.error.terminal, true);
        assert.equal(payload.capability.availableMode, 'empty');
        assert.equal(fs.existsSync(stateRoot), false, 'private-only rejection must precede job/staged-file mutation');
        evidence.private = {
            executed: false, status: privateResult.status, code: unavailable.code,
            terminal: true, availableMode: 'empty', diagnostics: unavailable.capability.diagnostics,
            taskRejectedBeforeMutation: true,
        };
    }
    for (const forbidden of ['mounts', 'systemFileSources', 'procMode', 'devices', 'bwrapArgs']) {
        assert.throws(() => validateInput({ command: 'true', [forbidden]: ['/'] }),
            (error) => error.code === 'BWRAP_RUNNER_INVALID_INPUT');
    }
    process.stdout.write(`${JSON.stringify({ ok: true, runnerAbi: BWRAP_RUNNER_ABI, selectedMode: selected.mode, policies: evidence })}\n`);
} finally {
    systemFiles.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
}
