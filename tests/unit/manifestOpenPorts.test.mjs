import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

function readManifest(agentName) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, agentName, 'manifest.json'), 'utf8'));
}

const expectedOpenPorts = Object.freeze({
    'bwrap-runner': Object.freeze({
        default: ['127.0.0.1:7119:7000'],
    }),
    keycloak: Object.freeze({
        default: ['8180:8180'],
        prod: ['8180:8180', '8443:8443'],
    }),
    ollama: Object.freeze({
        default: ['11434:11434'],
    }),
    postgres: Object.freeze({
        default: ['5432:5432'],
    }),
});

test('service manifests use openPorts and preserve their exact publication intent', () => {
    for (const [agentName, profiles] of Object.entries(expectedOpenPorts)) {
        const manifest = readManifest(agentName);
        assert.equal(Object.hasOwn(manifest, 'ports'), false, `${agentName} top-level ports must be absent`);
        for (const [profileName, expected] of Object.entries(profiles)) {
            const profile = manifest.profiles?.[profileName];
            assert.ok(profile, `${agentName} profile ${profileName} must exist`);
            assert.deepEqual(profile.openPorts, expected, `${agentName} ${profileName} openPorts changed`);
        }
        for (const [profileName, profile] of Object.entries(manifest.profiles || {})) {
            assert.equal(
                Object.hasOwn(profile, 'ports'),
                false,
                `${agentName} profile ${profileName} must not use legacy ports`,
            );
        }
    }
});
