import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    BWRAP_CAPABILITY_ERROR_CODE,
    BWRAP_PROC_MINIMUM,
    BWRAP_RUNNER_ABI,
    inspectCurrentProcfs,
    parseTrustedProcMinimum,
    resolveBwrapCapability,
} from '../../bwrap-runner/lib/capability.mjs';
import { buildBwrapArgs, validateInput } from '../../bwrap-runner/lib/policy.mjs';

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-capability-'));
    const executablePath = path.join(root, 'bwrap');
    fs.writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const procRoot = path.join(root, 'proc');
    const pid = 4321;
    fs.mkdirSync(path.join(procRoot, String(pid), 'ns'), { recursive: true });
    fs.symlinkSync(String(pid), path.join(procRoot, 'self'));
    fs.symlinkSync('pid:[9876]', path.join(procRoot, String(pid), 'ns', 'pid'));
    return { root, executablePath, procRoot, pid };
}

function success(output = 'bwrap-runner-capability-ok') {
    return { status: 0, signal: null, stdout: output, stderr: '' };
}

function resolveWith(f, spawnSyncApi, minimum = BWRAP_PROC_MINIMUM.PRIVATE_OR_EMPTY) {
    return resolveBwrapCapability({ executablePath: f.executablePath, minimum }, {
        spawnSyncApi,
        pid: f.pid,
        procRoot: f.procRoot,
    });
}

test('strict outer proc identity accepts only the current PID namespace view', () => {
    const f = fixture();
    try {
        const accepted = inspectCurrentProcfs({ pid: f.pid, procRoot: f.procRoot });
        assert.equal(accepted.ok, true);
        assert.equal(accepted.procSelfPid, f.pid);
        assert.equal(accepted.pidNamespace, 'pid:[9876]');
        assert.equal(Object.isFrozen(accepted), true);

        fs.rmSync(path.join(f.procRoot, 'self'));
        fs.symlinkSync('9999', path.join(f.procRoot, 'self'));
        const foreign = inspectCurrentProcfs({ pid: f.pid, procRoot: f.procRoot });
        assert.equal(foreign.ok, false);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('outer proc rejection occurs before any Bubblewrap probe', () => {
    const f = fixture();
    let probes = 0;
    try {
        fs.rmSync(path.join(f.procRoot, 'self'));
        fs.symlinkSync('9999', path.join(f.procRoot, 'self'));
        assert.throws(
            () => resolveWith(f, () => { probes += 1; return success(); }),
            (error) => error.code === BWRAP_CAPABILITY_ERROR_CODE
                && /Outer \/proc/.test(error.message)
                && error.terminal === true,
        );
        assert.equal(probes, 0);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('private proc is selected with representative task policy and a frozen identity', () => {
    const f = fixture();
    let observedArgs;
    try {
        const capability = resolveWith(f, (_binary, args, options) => {
            observedArgs = args;
            assert.deepEqual(options.env, {});
            return success();
        });
        assert.equal(capability.runnerAbi, BWRAP_RUNNER_ABI);
        assert.equal(capability.mode, 'private');
        assert.equal(capability.minimum, 'private-or-empty');
        assert.equal(path.isAbsolute(capability.binaryIdentity.realpath), true);
        assert.equal(Object.isFrozen(capability), true);
        assert.equal(Object.isFrozen(capability.binaryIdentity), true);
        assert.equal(Object.isFrozen(capability.diagnostics), true);
        for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net']) {
            assert.ok(observedArgs.includes(flag), `missing representative policy flag ${flag}`);
        }
        assert.deepEqual(observedArgs.slice(observedArgs.indexOf('--proc'), observedArgs.indexOf('--proc') + 2), [
            '--proc', '/proc',
        ]);
        assert.ok(observedArgs.includes('/work'));
        assert.ok(observedArgs.includes('/outputs'));
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('readiness capability applies the same trusted network policy as task arguments', () => {
    const f = fixture();
    let observedArgs;
    try {
        const capability = resolveBwrapCapability({
            executablePath: f.executablePath,
            allowNetwork: true,
        }, {
            spawnSyncApi: (_binary, args) => { observedArgs = args; return success(); },
            pid: f.pid,
            procRoot: f.procRoot,
        });
        assert.equal(capability.network, 'inherit');
        assert.equal(observedArgs.includes('--unshare-net'), false);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('empty proc is probed after every private failure without parsing diagnostics', () => {
    const f = fixture();
    const calls = [];
    try {
        const capability = resolveWith(f, (_binary, args) => {
            const mode = args.includes('--proc') ? 'private' : 'empty';
            calls.push(mode);
            if (mode === 'private') {
                return { status: 77, stdout: '', stderr: 'localized unrelated failure' };
            }
            return success();
        });
        assert.deepEqual(calls, ['private', 'empty']);
        assert.equal(capability.mode, 'empty');
        assert.equal(capability.diagnostics[0].status, 77);
        assert.equal(capability.diagnostics[1].ok, true);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('trusted private minimum rejects empty-only capability and cannot be loosened by task input', () => {
    const f = fixture();
    try {
        assert.throws(
            () => resolveWith(f, (_binary, args) => (
                args.includes('--proc')
                    ? { status: 1, stdout: '', stderr: 'private denied' }
                    : success()
            ), BWRAP_PROC_MINIMUM.PRIVATE),
            (error) => error.code === BWRAP_CAPABILITY_ERROR_CODE
                && error.capability.availableMode === 'empty'
                && error.capability.minimum === 'private',
        );
        assert.throws(
            () => validateInput({ command: 'true', procMode: 'empty' }),
            /unsupported field 'procMode'/,
        );
        assert.throws(
            () => validateInput({ command: 'true', minimum: 'private-or-empty' }),
            /unsupported field 'minimum'/,
        );
        assert.equal(parseTrustedProcMinimum([]), 'private-or-empty');
        assert.equal(parseTrustedProcMinimum(['--minimum=private']), 'private');
        assert.throws(() => parseTrustedProcMinimum(['--minimum=private-or-empty']), /tighten-only/);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('total probe failure returns bounded secret-free diagnostics', () => {
    const f = fixture();
    const statePath = path.join(f.root, 'state-must-not-exist');
    try {
        assert.throws(
            () => resolveWith(f, () => ({
                status: 1,
                stdout: '',
                stderr: `token=do-not-retain ${'x'.repeat(9_999)}€`,
            })),
            (error) => {
                assert.equal(error.code, BWRAP_CAPABILITY_ERROR_CODE);
                assert.equal(error.capability.diagnostics.length, 2);
                for (const diagnostic of error.capability.diagnostics) {
                    assert.ok(Buffer.byteLength(diagnostic.stderr) <= 2_048);
                    assert.doesNotMatch(diagnostic.stderr, /do-not-retain/);
                }
                return true;
            },
        );
        assert.equal(fs.existsSync(statePath), false);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('same-path executable replacement is re-resolved and re-probed without stale cache', async () => {
    const f = fixture();
    let probes = 0;
    try {
        const first = resolveWith(f, () => { probes += 1; return success(); });
        await new Promise((resolve) => setTimeout(resolve, 5));
        fs.writeFileSync(f.executablePath, '#!/bin/sh\necho replacement\nexit 0\n', { mode: 0o755 });
        const second = resolveWith(f, () => { probes += 1; return success(); });
        assert.equal(probes, 2);
        assert.notDeepEqual(first.binaryIdentity, second.binaryIdentity);
    } finally {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});

test('policy renders exactly the trusted selected proc mode without changing network or mounts', () => {
    const validated = validateInput({ command: 'true' });
    const common = {
        workDir: '/tmp/work',
        outputsDir: '/tmp/outputs',
        existingSystemPaths: new Set(['/usr']),
    };
    const privateArgs = buildBwrapArgs(validated, { ...common, procMode: 'private' });
    const emptyArgs = buildBwrapArgs(validated, { ...common, procMode: 'empty' });
    assert.deepEqual(privateArgs.filter((value) => value !== '--proc'), emptyArgs.filter((value) => value !== '--dir'));
    assert.ok(privateArgs.includes('--proc'));
    assert.ok(!privateArgs.includes('--dir'));
    assert.ok(emptyArgs.includes('--dir'));
    assert.ok(!emptyArgs.includes('--proc'));
    assert.ok(privateArgs.includes('--unshare-net'));
    assert.ok(emptyArgs.includes('--unshare-net'));
});

test('executable resolution rejects relative and non-executable paths without probing', () => {
    let probes = 0;
    assert.throws(
        () => resolveBwrapCapability({ executablePath: 'bwrap' }, {
            spawnSyncApi: () => { probes += 1; return success(); },
        }),
        (error) => error.code === BWRAP_CAPABILITY_ERROR_CODE,
    );
    assert.equal(probes, 0);
});

test('task entry point resolves capability before state, bundle, argument, or process mutation', () => {
    const source = fs.readFileSync(
        new URL('../../bwrap-runner/bin/sandbox-exec.mjs', import.meta.url),
        'utf8',
    );
    const capability = source.indexOf('capability = resolveBwrapCapability');
    assert.ok(capability > 0);
    for (const laterBoundary of [
        'const stateRoot = resolveStateDir()',
        'dirs = preparePerJobDirs',
        'stageFiles(dirs.workDir',
        'resolvedRuntimeBundle = resolveRuntimeBundle',
        'const args = buildBwrapArgs',
        'const result = await runBwrap',
    ]) {
        assert.ok(source.indexOf(laterBoundary) > capability, `${laterBoundary} must follow capability`);
    }
});
