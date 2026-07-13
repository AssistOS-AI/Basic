import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

function readManifest() {
    const manifestPath = path.join(repoRoot, 'web-publishing', 'manifest.json');
    assert.equal(fs.existsSync(manifestPath), true, 'web-publishing/manifest.json must exist');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('web-publishing joins the signaling and office trust zones without declaring aliases', () => {
    const manifest = readManifest();

    assert.deepEqual(manifest.network, {
        mode: 'bridge',
        attachments: [
            { name: 'webmeet-signaling', primary: true },
            { name: 'office-publishing' },
        ],
    });
    assert.equal(JSON.stringify(manifest.network).includes('aliases'), false);
});

test('web-publishing manifest declares distinct signaling and TURN provider outputs, never aliased', () => {
    const manifest = readManifest();
    const outputs = manifest.providesConfig?.outputs || [];
    const names = outputs.map((entry) => entry.name);

    for (const name of [
        'WEBMEET_PUBLIC_LIVEKIT_URL',
        'WEBMEET_LIVEKIT_URL',
        'WEBMEET_LIVEKIT_NODE_IP',
        'WEBMEET_TURN_HOST',
        'WEBMEET_TURN_EXTERNAL_IP',
        'WEBMEET_TURN_ALLOWED_PEER_IPS',
    ]) {
        assert.equal(names.filter((entry) => entry === name).length, 1, `${name} must be declared exactly once`);
    }

    const uniqueNames = new Set(names);
    assert.equal(uniqueNames.size, names.length, 'provider output names must not repeat/alias one another');
    for (const name of ['WEBMEET_TLS_HOSTNAME', 'WEBMEET_CERT_EMAIL', 'WEBMEET_LIVEKIT_UPSTREAM', 'WEBMEET_TURN_REALM']) {
        assert.equal(names.includes(name), false, `${name} must not be declared`);
    }
});

test('web-publishing provider outputs never include the TURN shared secret', () => {
    const manifest = readManifest();
    const outputs = manifest.providesConfig?.outputs || [];

    assert.equal(outputs.some((entry) => entry.name === 'WEBMEET_TURN_AUTH_SECRET'), false);
    assert.doesNotMatch(JSON.stringify(manifest), /WEBMEET_TURN_AUTH_SECRET/);
});
