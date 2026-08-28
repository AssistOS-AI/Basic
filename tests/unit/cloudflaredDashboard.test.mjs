import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSettingsComponentBase } from '../../../AssistOSExplorer/explorer/web-components/modals/settings-modal/settings-component-loader.js';

import {
    normalizeRouteDrafts,
    parseCloudflaredToolPayload,
    shouldCreateDnsRecords,
} from '../../cloudflared/IDE-plugins/cloudflared-settings/cloudflared-settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

test('normalizeRouteDrafts prepares only complete enabled route drafts', () => {
    assert.deepEqual(
        normalizeRouteDrafts([
            {
                id: 'keep-id',
                enabled: true,
                hostname: ' App.Example.COM ',
                path: 'office',
                originId: ' onlyoffice ',
                description: 'Office dashboard',
            },
            {
                enabled: true,
                hostname: '',
                path: '/missing-host',
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
                hostname: 'app.example.com',
                path: '/office',
                originId: 'onlyoffice',
                description: 'Office dashboard',
            },
        ],
    );
});

test('parseCloudflaredToolPayload extracts JSON MCP text content', () => {
    const parsed = parseCloudflaredToolPayload({
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    ok: true,
                    status: { state: 'missing-token' },
                }),
            },
        ],
    });

    assert.deepEqual(parsed, {
        ok: true,
        status: { state: 'missing-token' },
    });
});

test('parseCloudflaredToolPayload preserves MCP text errors', () => {
    const parsed = parseCloudflaredToolPayload({
        isError: true,
        content: [
            {
                type: 'text',
                text: 'MCP error -32603: Authentication error',
            },
        ],
    });

    assert.deepEqual(parsed, {
        ok: false,
        error: 'MCP error -32603: Authentication error',
    });
});

test('raw Explorer settings resolution points at existing dashboard files', () => {
    const base = resolveSettingsComponentBase({
        agent: 'cloudflared',
        component: 'cloudflared-settings',
        settingsComponent: 'cloudflared-settings',
        assetRootPath: 'cloudflared/IDE-plugins/cloudflared-settings',
    });

    assert.equal(
        base,
        '/workspace-files/cloudflared/IDE-plugins/cloudflared-settings/cloudflared-settings',
    );

    const localBase = path.join(
        repoRoot,
        base.replace('/workspace-files/cloudflared/', 'cloudflared/'),
    );
    for (const extension of ['html', 'css', 'js']) {
        assert.equal(
            fs.existsSync(`${localBase}.${extension}`),
            true,
            `settings loader path must exist for .${extension}`,
        );
    }
});

test('DNS record creation is opt-in from dashboard state', () => {
    const html = fs.readFileSync(
        path.join(repoRoot, 'cloudflared/IDE-plugins/cloudflared-settings/cloudflared-settings.html'),
        'utf8',
    );

    assert.doesNotMatch(
        html,
        /id="cloudflaredCreateDns"[^>]*\bchecked\b/,
        'Create DNS checkbox must not be checked by default',
    );
    assert.equal(shouldCreateDnsRecords(undefined), false);
    assert.equal(shouldCreateDnsRecords({ checked: false }), false);
    assert.equal(shouldCreateDnsRecords({ checked: true }), true);
});
