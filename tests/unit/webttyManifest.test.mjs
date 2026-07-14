import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

function readWebttyManifest() {
    const manifestPath = path.join(repoRoot, 'webtty', 'manifest.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('webtty keeps its browser server private while preserving router and readiness access', () => {
    const manifest = readWebttyManifest();
    const defaultProfile = manifest.profiles?.default || {};

    assert.equal(defaultProfile.additionalServerPort, '7681');
    assert.equal(Object.hasOwn(defaultProfile, 'openPorts'), false);
    assert.equal(Object.hasOwn(defaultProfile, 'ports'), false);
});
