import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizePublishingConfig } from '../../web-publishing/lib/routes.mjs';
import { buildProviderResponse } from '../../web-publishing/runtime/provider.mjs';
import { resolveRuntimeConfig } from '../../web-publishing/runtime/supervisor.mjs';
import {
    readConfig,
    readStatus,
    withFileLock,
    withOperationLock,
    writeStatus,
} from '../../web-publishing/runtime/status-store.mjs';

test('first start uses production env when no dashboard config file exists', async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-first-start-'));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const env = {
        WEB_PUBLISHING_CONFIG_FILE: path.join(tempDir, 'missing-config.json'),
        WEB_PUBLISHING_MODE: 'nginx-cloudflare',
        WEB_PUBLISHING_TLS_EDGE: 'cloudflare',
        WEB_PUBLISHING_BASE_DOMAIN: 'example.com',
        WEB_PUBLISHING_LIVEKIT_MEDIA_IP: '203.0.113.10',
        WEB_PUBLISHING_TURN_EXTERNAL_IP: '198.51.100.20',
    };

    const saved = await readConfig({ env });
    assert.deepEqual(saved, {});

    const config = await resolveRuntimeConfig(env, {
        readSavedConfig: async () => saved,
        readSavedSecretState: async () => ({}),
    });
    assert.equal(config.mode, 'nginx-cloudflare');
    assert.equal(config.tlsEdge, 'cloudflare');
    assert.equal(config.baseDomain, 'example.com');
    assert.equal(config.livekitMediaIp, '203.0.113.10');
    assert.equal(config.turnExternalIp, '198.51.100.20');
});

test('deployment env overrides stale saved topology consistently in provider and supervisor', async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-saved-config-'));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const configFile = path.join(tempDir, 'config.json');
    const oldSavedConfig = normalizePublishingConfig({
        mode: 'nginx',
        tlsEdge: 'external',
        baseDomain: 'saved.example.com',
        livekitMediaIp: '203.0.113.30',
        turnExternalIp: '198.51.100.40',
    }, {
        WEB_PUBLISHING_EXTERNAL_PROXY_CIDRS: '10.89.0.1/32',
    });
    assert.ok(oldSavedConfig.exposures.some((route) => route.hostname === 'meet.saved.example.com'));
    await fs.writeFile(configFile, JSON.stringify(oldSavedConfig));
    const env = {
        WEB_PUBLISHING_CONFIG_FILE: configFile,
        WEB_PUBLISHING_MODE: 'nginx-cloudflare',
        WEB_PUBLISHING_TLS_EDGE: 'cloudflare',
        WEB_PUBLISHING_BASE_DOMAIN: 'env.example.com',
        WEB_PUBLISHING_LIVEKIT_MEDIA_IP: '203.0.113.10',
        WEB_PUBLISHING_TURN_EXTERNAL_IP: '198.51.100.20',
    };

    const readSavedConfig = () => readConfig({ env });
    const readSavedSecretState = async () => ({});
    const runtimeConfig = await resolveRuntimeConfig(env, {
        readSavedConfig,
        readSavedSecretState,
    });
    const provider = await buildProviderResponse(env, {
        readConfig: readSavedConfig,
    });
    const providerValues = new Map(provider.values.map((entry) => [entry.name, entry.value]));

    assert.equal(runtimeConfig.mode, 'nginx-cloudflare');
    assert.equal(runtimeConfig.tlsEdge, 'cloudflare');
    assert.equal(runtimeConfig.baseDomain, 'env.example.com');
    assert.equal(runtimeConfig.livekitMediaIp, '203.0.113.10');
    assert.equal(runtimeConfig.turnExternalIp, '198.51.100.20');
    assert.ok(runtimeConfig.exposures.some((route) => route.hostname === 'meet.env.example.com'));
    assert.equal(runtimeConfig.exposures.some((route) => route.hostname.endsWith('saved.example.com')), false);
    assert.equal(providerValues.get('WEBMEET_PUBLIC_LIVEKIT_URL'), 'wss://meet.env.example.com');
    assert.equal(providerValues.get('WEBMEET_LIVEKIT_NODE_IP'), runtimeConfig.livekitMediaIp);
    assert.equal(providerValues.get('WEBMEET_TURN_EXTERNAL_IP'), runtimeConfig.turnExternalIp);
});

test('same-domain upgrades restore canonical Office routing and recompute derived origin services', async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-origin-migration-'));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const configFile = path.join(tempDir, 'config.json');
    const legacySavedConfig = {
        version: 1,
        mode: 'nginx-cloudflare',
        tlsEdge: 'cloudflare',
        baseDomain: 'example.com',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
        exposures: [{
            id: 'livekit',
            enabled: true,
            hostname: 'meet.example.com',
            path: '',
            originId: 'livekit-http',
            service: 'http://127.0.0.1:7880',
            description: 'Legacy normalized LiveKit signaling route.',
        }],
    };
    await fs.writeFile(configFile, JSON.stringify(legacySavedConfig));
    const env = {
        WEB_PUBLISHING_CONFIG_FILE: configFile,
        WEB_PUBLISHING_MODE: 'nginx-cloudflare',
        WEB_PUBLISHING_TLS_EDGE: 'cloudflare',
        WEB_PUBLISHING_BASE_DOMAIN: 'example.com',
        WEB_PUBLISHING_LIVEKIT_MEDIA_IP: '203.0.113.10',
        WEB_PUBLISHING_TURN_EXTERNAL_IP: '198.51.100.20',
    };
    const readSavedConfig = () => readConfig({ env });

    const runtimeConfig = await resolveRuntimeConfig(env, {
        readSavedConfig,
        readSavedSecretState: async () => ({}),
    });
    const provider = await buildProviderResponse(env, { readConfig: readSavedConfig });
    const providerValues = new Map(provider.values.map((entry) => [entry.name, entry.value]));

    const routesByOrigin = new Map(runtimeConfig.exposures.map((entry) => [entry.originId, entry]));
    assert.equal(runtimeConfig.exposures.length, 2);
    assert.equal(routesByOrigin.get('onlyoffice')?.service, 'http://onlyoffice:8080');
    assert.equal(routesByOrigin.get('livekit-http')?.service, 'http://livekitserveragent:7880');
    assert.equal(providerValues.get('ONLYOFFICE_PUBLIC_URL'), 'https://office.example.com');
    assert.equal(providerValues.get('WEBMEET_LIVEKIT_URL'), 'http://livekitserveragent:7880');
    assert.equal(providerValues.get('WEBMEET_PUBLIC_LIVEKIT_URL'), 'wss://meet.example.com');
});

test('concurrent status updates are atomically merged without lost fields', async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-status-lock-'));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const env = {
        WEB_PUBLISHING_STATUS_FILE: path.join(tempDir, 'status.json'),
    };

    await Promise.all(Array.from({ length: 24 }, (_, index) => (
        writeStatus({ [`field_${index}`]: index }, { env })
    )));

    const status = await readStatus({ env });
    for (let index = 0; index < 24; index += 1) {
        assert.equal(status[`field_${index}`], index);
    }
});

test('operation lock excludes a separate MCP process until the active operation completes', async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-process-lock-'));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const markerFile = path.join(tempDir, 'child-entered');
    const env = {
        WEB_PUBLISHING_CONFIG_FILE: path.join(tempDir, 'config.json'),
    };
    let releaseParent;
    let markParentEntered;
    const parentEntered = new Promise((resolve) => { markParentEntered = resolve; });
    const parentRelease = new Promise((resolve) => { releaseParent = resolve; });
    const parentOperation = withOperationLock(async () => {
        markParentEntered();
        await parentRelease;
    }, { env });
    await parentEntered;

    const statusStoreUrl = new URL('../../web-publishing/runtime/status-store.mjs', import.meta.url).href;
    const childScript = `
        import fs from 'node:fs/promises';
        import { withOperationLock } from ${JSON.stringify(statusStoreUrl)};
        const env = JSON.parse(process.env.WEB_PUBLISHING_TEST_ENV);
        await withOperationLock(
            () => fs.writeFile(${JSON.stringify(markerFile)}, 'entered'),
            { env },
        );
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
        env: {
            ...process.env,
            WEB_PUBLISHING_TEST_ENV: JSON.stringify(env),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childExit = once(child, 'exit');

    try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await assert.rejects(fs.access(markerFile), { code: 'ENOENT' });
    } finally {
        releaseParent();
        await parentOperation;
    }
    const [exitCode] = await childExit;
    assert.equal(exitCode, 0);
    assert.equal(await fs.readFile(markerFile, 'utf8'), 'entered');
});

test('a partially initialized live ticket blocks instead of corrupting ticket ordering', async (t) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-partial-ticket-'));
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    const lockFile = path.join(tempDir, 'state.lock');
    const otherId = `${process.pid}-000-partial-ticket`;
    const choosingFile = `${lockFile}.choosing.${otherId}`;
    const ticketFile = `${lockFile}.ticket.${otherId}`;
    await fs.writeFile(choosingFile, JSON.stringify({ id: otherId, pid: process.pid }));
    await fs.writeFile(ticketFile, '{');

    let entered = false;
    const operation = withFileLock(lockFile, async () => {
        entered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(entered, false);

    await fs.writeFile(ticketFile, JSON.stringify({ id: otherId, pid: process.pid, ticket: 1 }));
    await fs.unlink(choosingFile);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(entered, false, 'the equal-ticket predecessor must retain priority');

    await fs.unlink(ticketFile);
    await operation;
    assert.equal(entered, true);
});
