import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSettingsComponentBase } from '../../../AssistOSExplorer/explorer/web-components/modals/settings-modal/settings-component-loader.js';

import {
    applyPublishingConfig,
    draftConfigFromDocument,
    modeUsesCloudflareApply,
    normalizeExposureDrafts,
    parseWebPublishingToolPayload,
    refreshPublishingState,
    shouldCreateDnsRecords,
    updateStateIndicators,
    WebPublishingSettings,
} from '../../web-publishing/IDE-plugins/web-publishing-settings/web-publishing-settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

test('normalizeExposureDrafts prepares only complete enabled exposure drafts', () => {
    assert.deepEqual(
        normalizeExposureDrafts([
            {
                id: 'keep-id',
                enabled: true,
                hostname: ' Office.Example.COM ',
                path: 'docs',
                originId: ' onlyoffice ',
                description: 'OnlyOffice',
            },
            {
                enabled: true,
                hostname: '',
                originId: 'router',
            },
            {
                enabled: false,
                hostname: 'off.example.com',
                originId: 'router',
            },
        ]),
        [
            {
                id: 'keep-id',
                enabled: true,
                hostname: 'office.example.com',
                path: '/docs',
                originId: 'onlyoffice',
                description: 'OnlyOffice',
            },
        ],
    );
});

test('parseWebPublishingToolPayload extracts JSON MCP text content and errors', () => {
    assert.deepEqual(
        parseWebPublishingToolPayload({
            content: [{ type: 'text', text: JSON.stringify({ ok: true, mode: 'nginx' }) }],
        }),
        { ok: true, mode: 'nginx' },
    );

    assert.deepEqual(
        parseWebPublishingToolPayload({
            isError: true,
            content: [{ type: 'text', text: 'MCP error -32603: Authentication error' }],
        }),
        { ok: false, error: 'MCP error -32603: Authentication error' },
    );
});

test('Explorer settings resolution reuses the root web-publishing dashboard component', () => {
    const base = resolveSettingsComponentBase({
        agent: 'web-publishing',
        component: 'web-publishing-settings',
        settingsComponent: 'web-publishing-settings',
        assetRootPath: 'web-publishing/IDE-plugins/web-publishing-settings',
        componentBaseUrl: '/workspace-files/web-publishing/IDE-plugins/web-publishing-settings/web-publishing-settings',
    });

    assert.equal(
        base,
        '/workspace-files/web-publishing/IDE-plugins/web-publishing-settings/web-publishing-settings',
    );

    const localBase = path.join(repoRoot, base.replace('/workspace-files/web-publishing/', 'web-publishing/'));
    for (const extension of ['html', 'css', 'js']) {
        assert.equal(fs.existsSync(`${localBase}.${extension}`), true);
    }
});

test('settings module exposes a presenter that binds modal actions once', () => {
    const listeners = new Map();
    const elements = new Map(
        ['webPublishingRefresh', 'webPublishingValidate', 'webPublishingApply'].map((id) => [
            id,
            {
                addEventListener(event, listener) {
                    assert.equal(event, 'click');
                    const existing = listeners.get(id) || [];
                    existing.push(listener);
                    listeners.set(id, existing);
                },
            },
        ]),
    );
    let invalidations = 0;
    const presenter = new WebPublishingSettings(
        {
            querySelector(selector) {
                return elements.get(selector.replace(/^#/, '')) || null;
            },
        },
        () => {
            invalidations += 1;
        },
    );

    presenter.bindEvents();
    presenter.bindEvents();

    assert.equal(invalidations, 1);
    assert.deepEqual(
        Object.fromEntries([...listeners].map(([id, handlers]) => [id, handlers.length])),
        {
            webPublishingRefresh: 1,
            webPublishingValidate: 1,
            webPublishingApply: 1,
        },
    );
});

test('DNS creation is unchecked by default and legacy token text is absent from dashboard HTML', () => {
    const html = fs.readFileSync(
        path.join(repoRoot, 'web-publishing/IDE-plugins/web-publishing-settings/web-publishing-settings.html'),
        'utf8',
    );

    assert.doesNotMatch(html, /id="webPublishingCreateDns"[^>]*\bchecked\b/);
    assert.doesNotMatch(html, /CLOUDFLARED_TUNNEL_TOKEN/);
    assert.equal(shouldCreateDnsRecords(undefined), false);
    assert.equal(shouldCreateDnsRecords({ checked: false }), false);
    assert.equal(shouldCreateDnsRecords({ checked: true }), true);
});

test('dashboard apply drives Cloudflare API apply only for API or DNS flows', async () => {
    const elements = new Map([
        ['webPublishingMode', { value: 'cloudflare-api' }],
        ['webPublishingTlsEdge', { value: 'cloudflare' }],
        ['webPublishingBaseDomain', { value: 'example.com' }],
        ['webPublishingLivekitMediaIp', { value: '203.0.113.10' }],
        ['webPublishingTurnExternalIp', { value: '198.51.100.20' }],
        ['webPublishingTunnelSource', { value: '' }],
        ['webPublishingTunnelTokenSet', { value: 'false' }],
        ['webPublishingTunnelId', { value: '' }],
        ['webPublishingTunnelName', { value: '' }],
        ['webPublishingCreateDns', { checked: true }],
        ['webPublishingStatus', { textContent: '' }],
        ['webPublishingApiTokenState', { textContent: '' }],
        ['webPublishingAccountState', { textContent: '' }],
        ['webPublishingZoneState', { textContent: '' }],
        ['webPublishingTunnelTokenState', { textContent: '' }],
    ]);
    const documentRef = {
        getElementById(id) {
            return elements.get(id) || null;
        },
    };
    const calls = [];
    const result = await applyPublishingConfig({
        documentRef,
        invokeTool: async (tool, input = {}) => {
            calls.push({ tool, input });
            return {
                ok: true,
                applied: tool === 'web_publishing_cloudflare_tunnel_apply',
                restartRequired: false,
                config: {
                    mode: input.config?.mode || 'cloudflare-api',
                    cloudflare: {
                        apiTokenConfigured: true,
                        accountIdConfigured: true,
                        zoneIdConfigured: true,
                    },
                    tunnel: { tokenSet: true },
                },
            };
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((entry) => entry.tool), [
        'web_publishing_config_apply',
        'web_publishing_cloudflare_tunnel_apply',
    ]);
    assert.deepEqual(calls[1].input, {
        config: {
            mode: 'cloudflare-api',
            tlsEdge: 'cloudflare',
            baseDomain: 'example.com',
            livekitMediaIp: '203.0.113.10',
            turnExternalIp: '198.51.100.20',
            tunnel: {
                source: '',
                tokenSet: false,
                tunnelId: '',
                tunnelName: '',
            },
        },
        createDnsRecords: true,
    });
    assert.equal(elements.get('webPublishingStatus').textContent, 'Applied');
    assert.equal(elements.get('webPublishingTunnelTokenState').textContent, 'present');
    assert.equal(modeUsesCloudflareApply('nginx-cloudflare', false), false);
    assert.equal(modeUsesCloudflareApply('nginx-cloudflare', true), true);
});

test('dashboard performs no Cloudflare operation before a restart-required local cutover', async () => {
    const elements = new Map([
        ['webPublishingMode', { value: 'cloudflare-api' }],
        ['webPublishingTlsEdge', { value: 'cloudflare' }],
        ['webPublishingBaseDomain', { value: 'example.com' }],
        ['webPublishingLivekitMediaIp', { value: '203.0.113.10' }],
        ['webPublishingTurnExternalIp', { value: '198.51.100.20' }],
        ['webPublishingTunnelSource', { value: '' }],
        ['webPublishingTunnelTokenSet', { value: 'false' }],
        ['webPublishingTunnelId', { value: '' }],
        ['webPublishingTunnelName', { value: '' }],
        ['webPublishingCreateDns', { checked: true }],
        ['webPublishingStatus', { textContent: '' }],
    ]);
    const calls = [];
    const result = await applyPublishingConfig({
        documentRef: {
            getElementById(id) {
                return elements.get(id) || null;
            },
        },
        invokeTool: async (tool, input = {}) => {
            calls.push({ tool, input });
            if (tool === 'web_publishing_config_apply') {
                return { ok: true, persisted: true, applied: false, restartRequired: true };
            }
            throw new Error('Cloudflare apply must not be called before restart');
        },
    });

    assert.equal(result.restartRequired, true);
    assert.deepEqual(calls.map(({ tool }) => tool), ['web_publishing_config_apply']);
    assert.equal(
        elements.get('webPublishingStatus').textContent,
        'Saved; restart Web Publishing to apply',
    );
});

test('dashboard preserves restarted API tunnel identity for ordinary remote apply', async () => {
    const elements = new Map([
        ['webPublishingMode', { value: 'cloudflare-api' }],
        ['webPublishingTlsEdge', { value: 'cloudflare' }],
        ['webPublishingBaseDomain', { value: 'example.com' }],
        ['webPublishingLivekitMediaIp', { value: '203.0.113.10' }],
        ['webPublishingTurnExternalIp', { value: '198.51.100.20' }],
        ['webPublishingTunnelSource', { value: '' }],
        ['webPublishingTunnelTokenSet', { value: 'false' }],
        ['webPublishingTunnelId', { value: '' }],
        ['webPublishingTunnelName', { value: '' }],
        ['webPublishingCreateDns', { checked: false }],
        ['webPublishingStatus', { textContent: '' }],
        ['webPublishingApiTokenState', { textContent: '' }],
        ['webPublishingAccountState', { textContent: '' }],
        ['webPublishingZoneState', { textContent: '' }],
        ['webPublishingTunnelTokenState', { textContent: '' }],
    ]);
    const documentRef = {
        getElementById(id) {
            return elements.get(id) || null;
        },
    };
    const activeConfig = {
        mode: 'cloudflare-api',
        tlsEdge: 'cloudflare',
        baseDomain: 'example.com',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
        tunnel: {
            source: 'cloudflare-api',
            tokenSet: true,
            tunnelId: 'restarted-tunnel-id',
            tunnelName: 'workspace',
        },
    };
    await refreshPublishingState({
        documentRef,
        invokeTool: async () => ({
            ok: true,
            config: activeConfig,
            cloudflare: {},
            status: { state: 'running' },
        }),
    });
    assert.deepEqual(draftConfigFromDocument(documentRef).tunnel, activeConfig.tunnel);
    assert.equal(
        elements.get('webPublishingStatus').textContent,
        'Mode cloudflare-api · state running',
    );

    const calls = [];
    const result = await applyPublishingConfig({
        documentRef,
        invokeTool: async (tool, input) => {
            calls.push({ tool, input });
            assert.deepEqual(input.config.tunnel, activeConfig.tunnel);
            if (tool === 'web_publishing_config_apply') {
                return { ok: true, applied: true, restartRequired: false, config: activeConfig };
            }
            return { ok: true, applied: true, remoteApplied: true, restartRequired: false, config: activeConfig };
        },
    });
    assert.equal(result.remoteApplied, true);
    assert.deepEqual(calls.map(({ tool }) => tool), [
        'web_publishing_config_apply',
        'web_publishing_cloudflare_tunnel_apply',
    ]);
    assert.equal(elements.get('webPublishingStatus').textContent, 'Applied');
});

test('dashboard state indicators render present and missing without secret values', () => {
    const elements = new Map([
        ['webPublishingApiTokenState', { textContent: '' }],
        ['webPublishingAccountState', { textContent: '' }],
        ['webPublishingZoneState', { textContent: '' }],
        ['webPublishingTunnelTokenState', { textContent: '' }],
    ]);
    updateStateIndicators({
        config: {
            cloudflare: {
                apiTokenConfigured: true,
                accountIdConfigured: false,
                zoneIdConfigured: true,
            },
            tunnel: { tokenSet: false },
        },
        secrets: { tunnelTokenSet: true },
    }, {
        getElementById(id) {
            return elements.get(id) || null;
        },
    });

    assert.equal(elements.get('webPublishingApiTokenState').textContent, 'present');
    assert.equal(elements.get('webPublishingAccountState').textContent, 'missing');
    assert.equal(elements.get('webPublishingZoneState').textContent, 'present');
    assert.equal(elements.get('webPublishingTunnelTokenState').textContent, 'present');
});
