import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    buildBwrapArgs,
    getSystemReadOnlyPaths,
    validateInput,
} from './policy.mjs';

export const BWRAP_RUNNER_ABI = 2;
export const BWRAP_CAPABILITY_ERROR_CODE = 'PLOINKY_BWRAP_CAPABILITY_UNAVAILABLE';
export const BWRAP_PROC_MINIMUM = Object.freeze({
    PRIVATE_OR_EMPTY: 'private-or-empty',
    PRIVATE: 'private',
});

const PROBE_TIMEOUT_MS = 10_000;
const MAX_DIAGNOSTIC_BYTES = 2_048;
const PROBE_OUTPUT = 'bwrap-runner-capability-ok';

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) deepFreeze(nested);
    return Object.freeze(value);
}

function safeText(value, maxBytes = MAX_DIAGNOSTIC_BYTES) {
    let text = String(value ?? '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\b(Bearer)\s+\S+/gi, '$1 <redacted>')
        .replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*\S+/gi, '$1=<redacted>');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > maxBytes) {
        text = bytes.subarray(bytes.length - maxBytes).toString('utf8');
        // A tail slice can begin in the middle of a multibyte sequence, whose
        // replacement character would otherwise expand the encoded result
        // beyond the byte cap. Trim whole leading code points until the bound
        // is exact again.
        while (Buffer.byteLength(text, 'utf8') > maxBytes && text.length > 0) {
            const firstWidth = text.codePointAt(0) > 0xffff ? 2 : 1;
            text = text.slice(firstWidth);
        }
    }
    return text;
}

function capabilityError(message, capability) {
    const error = new Error(message);
    error.code = BWRAP_CAPABILITY_ERROR_CODE;
    error.terminal = true;
    error.capability = deepFreeze(capability);
    return error;
}

function validateMinimum(minimum) {
    if (!Object.values(BWRAP_PROC_MINIMUM).includes(minimum)) {
        throw new TypeError(`unsupported trusted Bubblewrap proc minimum '${safeText(minimum, 64)}'`);
    }
    return minimum;
}

export function inspectCurrentProcfs({
    fsApi = fs,
    pid = process.pid,
    procRoot = '/proc',
} = {}) {
    const processPid = Number(pid);
    try {
        const selfPath = path.join(procRoot, 'self');
        const procSelfTarget = fsApi.readlinkSync(selfPath);
        const procSelfPid = Number(path.basename(procSelfTarget));
        const expectedNamespacePath = path.join(procRoot, String(processPid), 'ns', 'pid');
        const selfNamespacePath = path.join(procRoot, 'self', 'ns', 'pid');
        const expectedNamespace = fsApi.readlinkSync(expectedNamespacePath);
        const selfNamespace = fsApi.readlinkSync(selfNamespacePath);
        const ok = Number.isInteger(processPid)
            && processPid > 0
            && Number.isInteger(procSelfPid)
            && procSelfPid === processPid
            && expectedNamespace.length > 0
            && expectedNamespace === selfNamespace;
        return deepFreeze({
            ok,
            processPid,
            procSelfPid: Number.isInteger(procSelfPid) ? procSelfPid : null,
            pidNamespace: expectedNamespace || null,
            error: null,
        });
    } catch (error) {
        return deepFreeze({
            ok: false,
            processPid,
            procSelfPid: null,
            pidNamespace: null,
            error: safeText(error?.message || error, 512),
        });
    }
}

export function resolveExecutableIdentity(executablePath, { fsApi = fs } = {}) {
    if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
        throw capabilityError('Bubblewrap executable path must be absolute', {
            runnerAbi: BWRAP_RUNNER_ABI,
            minimum: null,
            availableMode: null,
            binaryIdentity: null,
            procfs: null,
            diagnostics: [],
        });
    }

    try {
        const realpath = fsApi.realpathSync(executablePath);
        if (!path.isAbsolute(realpath)) {
            throw new Error('resolved executable path was not absolute');
        }
        const stat = fsApi.statSync(realpath);
        if (!stat.isFile()) throw new Error('resolved path is not a regular file');
        if ((stat.mode & 0o111) === 0) throw new Error('resolved file is not executable');
        return deepFreeze({
            requestedPath: executablePath,
            realpath,
            device: Number(stat.dev),
            inode: Number(stat.ino),
            size: Number(stat.size),
            mode: Number(stat.mode),
            mtimeMs: Number(stat.mtimeMs),
            ctimeMs: Number(stat.ctimeMs),
        });
    } catch (error) {
        throw capabilityError('Bubblewrap executable is unavailable or unsafe', {
            runnerAbi: BWRAP_RUNNER_ABI,
            minimum: null,
            availableMode: null,
            binaryIdentity: null,
            procfs: null,
            diagnostics: [{ stage: 'resolve-binary', message: safeText(error?.message || error, 512) }],
        });
    }
}

function existingSystemPaths(fsApi) {
    const result = new Set();
    for (const candidate of getSystemReadOnlyPaths()) {
        try {
            fsApi.accessSync(candidate, fs.constants.R_OK);
            result.add(candidate);
        } catch (_) {}
    }
    return result;
}

function buildRepresentativeProbeArgs(mode, fsApi, allowNetwork) {
    const validated = validateInput({
        command: `test -d /work && test -d /outputs && test -d /proc && printf ${PROBE_OUTPUT}`,
    }, { allowNetwork });
    return buildBwrapArgs(validated, {
        workDir: '/tmp',
        outputsDir: '/tmp',
        existingSystemPaths: existingSystemPaths(fsApi),
        procMode: mode,
    });
}

function probeMode(mode, binaryIdentity, { fsApi, spawnSyncApi, allowNetwork }) {
    const args = buildRepresentativeProbeArgs(mode, fsApi, allowNetwork);
    let result;
    try {
        result = spawnSyncApi(binaryIdentity.realpath, args, {
            encoding: 'utf8',
            timeout: PROBE_TIMEOUT_MS,
            env: {},
        });
    } catch (error) {
        result = { error };
    }
    const stdout = safeText(result?.stdout, MAX_DIAGNOSTIC_BYTES).trim();
    const stderr = safeText(result?.stderr, MAX_DIAGNOSTIC_BYTES).trim();
    const ok = !result?.error && result?.status === 0 && stdout === PROBE_OUTPUT;
    return deepFreeze({
        mode,
        ok,
        status: Number.isInteger(result?.status) ? result.status : null,
        signal: typeof result?.signal === 'string' ? safeText(result.signal, 64) : null,
        error: result?.error ? safeText(result.error?.message || result.error, 512) : null,
        stdout,
        stderr,
    });
}

export function resolveBwrapCapability({
    executablePath = '/usr/bin/bwrap',
    minimum = BWRAP_PROC_MINIMUM.PRIVATE_OR_EMPTY,
    allowNetwork = false,
} = {}, {
    fsApi = fs,
    spawnSyncApi = spawnSync,
    pid = process.pid,
    procRoot = '/proc',
} = {}) {
    const trustedMinimum = validateMinimum(minimum);
    const trustedNetworkPolicy = allowNetwork === true;
    let binaryIdentity;
    try {
        binaryIdentity = resolveExecutableIdentity(executablePath, { fsApi });
    } catch (error) {
        if (error?.capability) {
            error.capability = deepFreeze({
                ...error.capability,
                minimum: trustedMinimum,
                network: trustedNetworkPolicy ? 'inherit' : 'none',
            });
        }
        throw error;
    }

    const procfs = inspectCurrentProcfs({ fsApi, pid, procRoot });
    if (!procfs.ok) {
        throw capabilityError(
            'Outer /proc does not represent the runner process PID namespace',
            {
                runnerAbi: BWRAP_RUNNER_ABI,
                minimum: trustedMinimum,
                network: trustedNetworkPolicy ? 'inherit' : 'none',
                availableMode: null,
                binaryIdentity,
                procfs,
                diagnostics: [],
            },
        );
    }

    const diagnostics = [];
    const privateProbe = probeMode('private', binaryIdentity, {
        fsApi,
        spawnSyncApi,
        allowNetwork: trustedNetworkPolicy,
    });
    diagnostics.push(privateProbe);
    if (privateProbe.ok) {
        return deepFreeze({
            runnerAbi: BWRAP_RUNNER_ABI,
            mode: 'private',
            minimum: trustedMinimum,
            network: trustedNetworkPolicy ? 'inherit' : 'none',
            binaryIdentity,
            procfs,
            diagnostics,
        });
    }

    // Any private-proc failure triggers the safe empty-proc probe. Never parse
    // localized stderr to decide whether the fallback is permitted.
    const emptyProbe = probeMode('empty', binaryIdentity, {
        fsApi,
        spawnSyncApi,
        allowNetwork: trustedNetworkPolicy,
    });
    diagnostics.push(emptyProbe);
    if (emptyProbe.ok && trustedMinimum === BWRAP_PROC_MINIMUM.PRIVATE_OR_EMPTY) {
        return deepFreeze({
            runnerAbi: BWRAP_RUNNER_ABI,
            mode: 'empty',
            minimum: trustedMinimum,
            network: trustedNetworkPolicy ? 'inherit' : 'none',
            binaryIdentity,
            procfs,
            diagnostics,
        });
    }

    const availableMode = emptyProbe.ok ? 'empty' : null;
    const message = availableMode === 'empty'
        ? 'Bubblewrap provides only empty proc, below the trusted private-proc minimum'
        : 'Bubblewrap cannot create either a private or safe empty proc sandbox';
    throw capabilityError(message, {
        runnerAbi: BWRAP_RUNNER_ABI,
        minimum: trustedMinimum,
        network: trustedNetworkPolicy ? 'inherit' : 'none',
        availableMode,
        binaryIdentity,
        procfs,
        diagnostics,
    });
}

export function parseTrustedProcMinimum(argv = []) {
    if (!Array.isArray(argv) || argv.length === 0) {
        return BWRAP_PROC_MINIMUM.PRIVATE_OR_EMPTY;
    }
    if (argv.length === 1 && argv[0] === '--minimum=private') {
        return BWRAP_PROC_MINIMUM.PRIVATE;
    }
    throw new TypeError('only the tighten-only trusted option --minimum=private is supported');
}
