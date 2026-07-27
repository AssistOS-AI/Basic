import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const execFileAsync = promisify(execFile);

function readWebttyManifest() {
    const manifestPath = path.join(repoRoot, 'webtty', 'manifest.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('webtty keeps its browser server private for the Ploinky runtime relay', () => {
    const manifest = readWebttyManifest();
    const defaultProfile = manifest.profiles?.default || {};

    assert.equal(Object.hasOwn(defaultProfile, 'openPorts'), false);
    assert.equal(Object.hasOwn(defaultProfile, 'ports'), false);
    assert.equal(Object.hasOwn(manifest, 'routerAccess'), false);
    assert.equal(manifest.start, '/usr/local/bin/webtty-start');
    assert.equal(manifest.health?.readiness?.script, 'healthcheck.sh');
    assert.equal(defaultProfile.env?.PORT?.default, '7681');
    assert.deepEqual(manifest.httpServices, [{
        slug: 'webtty',
        port: 7681,
        externalPrefix: '/services/webtty/',
        internalPrefix: '/',
        access: 'authenticated',
    }]);
});

test('webtty readiness checks its in-container loopback listener', async (t) => {
    const server = net.createServer((socket) => socket.end());
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const script = path.join(repoRoot, 'webtty', 'healthcheck.sh');
    await execFileAsync('sh', [script], {
        env: {
            ...process.env,
            PORT: String(server.address().port),
        },
        timeout: 5000,
    });
});
