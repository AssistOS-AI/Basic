#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    buildCloudflaredIngress,
    mergePublishingConfig,
    normalizePublishingConfig,
} from '../lib/routes.mjs';
import { writeAndValidateNginxConfig } from '../lib/nginx-config.mjs';
import { runtimeConfigFingerprint } from './config-fingerprint.mjs';
import { readConfig, readSecretState, writeStatus } from './status-store.mjs';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;

function redactArgs(args) {
    return args.map((arg, index) => {
        if (args[index - 1] === '--token') return '[redacted-token]';
        if (args[index - 1] === '--token-file') return '[private-token-file]';
        return String(arg).replace(/eyJ[A-Za-z0-9._-]+/g, '[redacted-token]');
    });
}

function withoutCloudflareSecrets(env) {
    return Object.fromEntries(Object.entries(env).filter(([name]) => {
        if (name === 'TUNNEL_TOKEN') return false;
        return !(/CLOUDFLARE/i.test(name) && /(TOKEN|SECRET|KEY|PASSWORD)/i.test(name));
    }));
}

function scrubCloudflareSecretsInPlace(env) {
    for (const name of Object.keys(env)) {
        if (name === 'TUNNEL_TOKEN'
            || (/CLOUDFLARE/i.test(name) && /(TOKEN|SECRET|KEY|PASSWORD)/i.test(name))) {
            Reflect.deleteProperty(env, name);
        }
    }
}

function cloudflaredEnvironment(env) {
    const allowedNames = [
        'PATH',
        'HOME',
        'TMPDIR',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'LANG',
        'LC_ALL',
        'TZ',
    ];
    return Object.fromEntries(
        allowedNames
            .filter((name) => env[name] !== undefined)
            .map((name) => [name, env[name]]),
    );
}

export async function createPrivateTokenFile(token, {
    fsApi = fs,
    tmpdir = os.tmpdir(),
} = {}) {
    const directory = await fsApi.mkdtemp(path.join(tmpdir, 'web-publishing-cloudflared-'));
    const tokenFile = path.join(directory, 'token');
    try {
        await fsApi.chmod(directory, 0o700);
        await fsApi.writeFile(tokenFile, `${token}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        await fsApi.chmod(tokenFile, 0o600);
    } catch (error) {
        await fsApi.rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
    return {
        path: tokenFile,
        async remove() {
            await fsApi.rm(directory, { recursive: true, force: true });
        },
    };
}

function cloudflaredToken(env, secretState = {}) {
    return String(
        env.TUNNEL_TOKEN
        || env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN
        || secretState.tunnelToken
        || ''
    ).trim();
}

function cloudflaredRequirement(config, token) {
    const mode = String(config.mode || '');
    if (!mode.includes('cloudflare')) {
        return { required: false, state: 'disabled' };
    }
    if (mode === 'cloudflare-api' && !token && !config.tunnel?.tunnelId) {
        return { required: false, state: 'awaiting-provision' };
    }
    return { required: true, state: token ? 'starting' : 'missing-token' };
}

function watchChild(name, child) {
    const record = {
        name,
        child,
        event: null,
        done: null,
    };
    record.done = new Promise((resolve) => {
        const settle = (event) => {
            if (record.event) return;
            record.event = event;
            resolve(record);
        };
        child.once('error', (error) => settle({ type: 'error', error }));
        child.once('exit', (code, signal) => settle({ type: 'exit', code, signal }));
    });
    return record;
}

function childStatus(record) {
    const { event, child } = record;
    if (!event) return { state: 'running', pid: child.pid };
    if (event.type === 'error') {
        return {
            state: 'failed',
            pid: child.pid,
            error: event.error?.message || String(event.error),
        };
    }
    return {
        state: 'exited',
        pid: child.pid,
        code: event.code,
        signal: event.signal,
    };
}

function childFailure(record) {
    if (record.event?.type === 'error') {
        return `${record.name} process error: ${record.event.error?.message || String(record.event.error)}`;
    }
    return `${record.name} exited unexpectedly (code=${record.event?.code ?? 'null'}, signal=${record.event?.signal ?? 'null'}).`;
}

function isChildRunning(record) {
    return !record.event
        && record.child.exitCode == null
        && record.child.signalCode == null;
}

async function waitForChildren(records, timeoutMs) {
    const pending = records.filter(isChildRunning).map((record) => record.done);
    if (!pending.length) return true;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        Promise.all(pending).then(() => finish(true));
    });
}

async function terminateChildren(records, {
    signal = 'SIGTERM',
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
} = {}) {
    for (const record of records.filter(isChildRunning)) {
        try {
            record.child.kill(signal);
        } catch {
            // A child can disappear between the liveness check and kill. Its
            // lifecycle event, or the bounded timeout below, settles cleanup.
        }
    }
    if (await waitForChildren(records, shutdownTimeoutMs)) return [];

    for (const record of records.filter(isChildRunning)) {
        try {
            record.child.kill('SIGKILL');
        } catch {
            // The final liveness check below records any child that still did
            // not terminate; the supervisor itself must not wait forever.
        }
    }
    await waitForChildren(records, killTimeoutMs);
    return records.filter(isChildRunning);
}

async function startNginx(config, {
    env,
    spawnProcess,
    spawnSyncProcess,
    validateNginxConfig,
    writeStatusFn,
}) {
    await validateNginxConfig(config.exposures, {
        tlsEdge: config.tlsEdge,
        externalProxyCidrs: config.externalProxyCidrs,
    });
    const nginxCheck = spawnSyncProcess('nginx', ['-v'], {
        encoding: 'utf8',
        env: withoutCloudflareSecrets(env),
    });
    if (nginxCheck.error || nginxCheck.status !== 0) {
        const detail = nginxCheck.error?.message
            || String(nginxCheck.stderr || nginxCheck.stdout || `exit ${nginxCheck.status}`);
        await writeStatusFn({ nginx: { state: 'unavailable', error: detail } });
        throw new Error(`Required Nginx executable is unavailable: ${detail}`);
    }
    const child = spawnProcess('nginx', [
        '-g',
        'daemon off;',
        '-c',
        env.WEB_PUBLISHING_NGINX_CONFIG_FILE || '/tmp/web-publishing-nginx.conf',
    ], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: withoutCloudflareSecrets(env),
    });
    const record = watchChild('nginx', child);
    await writeStatusFn({ nginx: { state: 'running', pid: child.pid } });
    if (record.event) throw new Error(childFailure(record));
    return record;
}

async function startCloudflared(config, token, {
    createTokenFile,
    env,
    spawnProcess,
    writeStatusFn,
}) {
    const requirement = cloudflaredRequirement(config, token);
    const { required } = requirement;
    const args = ['tunnel', '--no-autoupdate', 'run'];
    const status = {
        state: requirement.state,
        required,
        tokenSet: Boolean(token),
        args: redactArgs(args),
    };
    await writeStatusFn({
        cloudflared: status,
        ingress: buildCloudflaredIngress(config.exposures),
    });
    if (!required) return null;
    if (!token) {
        throw new Error('A scoped Cloudflare tunnel token is required in Cloudflare publishing mode.');
    }
    const privateTokenFile = await createTokenFile(token);
    let record = null;
    try {
        const childArgs = [...args, '--token-file', privateTokenFile.path];
        const child = spawnProcess('cloudflared', childArgs, {
            stdio: ['ignore', 'inherit', 'inherit'],
            env: cloudflaredEnvironment(env),
        });
        record = watchChild('cloudflared', child);
        record.cleanup = () => privateTokenFile.remove();
        await writeStatusFn({
            cloudflared: {
                ...status,
                state: 'running',
                pid: child.pid,
                args: redactArgs(childArgs),
            },
        });
        if (record.event) throw new Error(childFailure(record));
        return record;
    } catch (error) {
        if (record && isChildRunning(record)) {
            try {
                record.child.kill('SIGTERM');
            } catch {
                // The process already disappeared; startup still fails below.
            }
        }
        await privateTokenFile.remove().catch(() => {});
        throw error;
    }
}

function signalPromise(signalSource) {
    let resolveSignal;
    const promise = new Promise((resolve) => {
        resolveSignal = resolve;
    });
    const onSigint = () => resolveSignal({ type: 'signal', signal: 'SIGINT' });
    const onSigterm = () => resolveSignal({ type: 'signal', signal: 'SIGTERM' });
    signalSource.once('SIGINT', onSigint);
    signalSource.once('SIGTERM', onSigterm);
    return {
        promise,
        remove() {
            signalSource.removeListener('SIGINT', onSigint);
            signalSource.removeListener('SIGTERM', onSigterm);
        },
    };
}

export async function resolveRuntimeConfig(env = process.env, {
    readSavedConfig = () => readConfig({ env }),
    readSavedSecretState = () => readSecretState({ env }),
} = {}) {
    const saved = await readSavedConfig();
    const secretState = await readSavedSecretState();
    return normalizePublishingConfig(
        mergePublishingConfig(saved, env, secretState),
        env,
    );
}

export async function superviseRuntime(config, secretState = {}, {
    env = process.env,
    signalSource = process,
    spawnProcess = spawn,
    spawnSyncProcess = spawnSync,
    validateNginxConfig = writeAndValidateNginxConfig,
    createTokenFile = createPrivateTokenFile,
    writeStatusFn = writeStatus,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
} = {}) {
    // Capture only the connector credential needed for startup, then remove all
    // Cloudflare credential variables from the supervisor's long-lived mutable
    // environment before its first await. The short-lived local is cleared as
    // soon as cloudflared has consumed it into its private token file.
    let startupToken = cloudflaredToken(env, secretState);
    scrubCloudflareSecretsInPlace(env);
    if (secretState && typeof secretState === 'object') {
        Reflect.deleteProperty(secretState, 'tunnelToken');
    }
    const records = [];
    const shutdownSignal = signalPromise(signalSource);
    try {
        const connectorRequirement = cloudflaredRequirement(config, startupToken);
        await writeStatusFn({ state: 'starting', mode: config.mode, error: '' });
        records.push(await startNginx(config, {
            env,
            spawnProcess,
            spawnSyncProcess,
            validateNginxConfig,
            writeStatusFn,
        }));
        const cloudflared = await startCloudflared(config, startupToken, {
            createTokenFile,
            env,
            spawnProcess,
            writeStatusFn,
        });
        startupToken = '';
        if (cloudflared) records.push(cloudflared);

        const alreadyFailed = records.find((record) => record.event);
        if (alreadyFailed) throw new Error(childFailure(alreadyFailed));
        await writeStatusFn({
            state: connectorRequirement.state === 'awaiting-provision'
                ? 'awaiting-provision'
                : 'running',
            mode: config.mode,
            error: '',
            supervisorPid: process.pid,
            activeConfigFingerprint: runtimeConfigFingerprint(config),
        });

        const outcome = await Promise.race([
            shutdownSignal.promise,
            ...records.map((record) => record.done),
        ]);
        if (outcome?.type === 'signal') {
            await writeStatusFn({ state: 'stopping', signal: outcome.signal });
            const survivors = await terminateChildren(records, {
                signal: outcome.signal,
                shutdownTimeoutMs,
                killTimeoutMs,
            });
            if (survivors.length) {
                const names = survivors.map((record) => record.name).join(', ');
                await writeStatusFn({
                    state: 'failed',
                    error: `Timed out terminating required child processes: ${names}.`,
                });
                return 1;
            }
            await writeStatusFn({
                state: 'stopped',
                signal: outcome.signal,
                ...Object.fromEntries(records.map((record) => [record.name, childStatus(record)])),
            });
            return 0;
        }

        const failedRecord = outcome;
        const error = childFailure(failedRecord);
        await writeStatusFn({
            state: 'failed',
            error,
            [failedRecord.name]: childStatus(failedRecord),
        });
        await terminateChildren(
            records.filter((record) => record !== failedRecord),
            { shutdownTimeoutMs, killTimeoutMs },
        );
        return 1;
    } catch (error) {
        await writeStatusFn({
            state: 'failed',
            error: error?.message || String(error),
        }).catch(() => {});
        await terminateChildren(records, { shutdownTimeoutMs, killTimeoutMs });
        return 1;
    } finally {
        startupToken = '';
        shutdownSignal.remove();
        await Promise.all(records.map((record) => record.cleanup?.().catch(() => {})));
    }
}

export async function runSupervisor(env = process.env, dependencies = {}) {
    const readSecretStateFn = dependencies.readSecretStateFn || (() => readSecretState({ env }));
    const secretState = await readSecretStateFn();
    const config = await resolveRuntimeConfig(env, {
        ...(dependencies.readSavedConfig
            ? { readSavedConfig: dependencies.readSavedConfig }
            : {}),
        readSavedSecretState: async () => secretState,
    });
    return superviseRuntime(config, secretState, { env, ...dependencies });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runSupervisor().then(
        (exitCode) => process.exit(exitCode),
        async (error) => {
            await writeStatus({
                state: 'failed',
                error: error?.message || String(error),
            }).catch(() => {});
            process.stderr.write(`[web-publishing] ${error?.stack || error}\n`);
            process.exit(1);
        },
    );
}
