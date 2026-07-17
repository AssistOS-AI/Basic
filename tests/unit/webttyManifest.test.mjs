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

test('webtty routes its browser server through an authenticated explicit service target', () => {
    const manifest = readWebttyManifest();
    const defaultProfile = manifest.profiles?.default || {};

    assert.equal(Object.hasOwn(defaultProfile, 'openPorts'), false);
    assert.equal(Object.hasOwn(defaultProfile, 'ports'), false);
    assert.equal(manifest.routerAccess, undefined);
    assert.deepEqual(manifest.httpServices, [{
        slug: 'webtty',
        externalPrefix: '/services/webtty/',
        internalPrefix: '/',
        access: 'authenticated',
        port: 7681,
    }]);
});
