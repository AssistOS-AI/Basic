import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readManifest(agentName) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, agentName, 'manifest.json'), 'utf8'));
}

test('all manifest-declared writable host volumes are positively classified beneath .data', () => {
    const manifests = fs.readdirSync(repoRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => [entry.name, path.join(repoRoot, entry.name, 'manifest.json')])
        .filter(([, manifestPath]) => fs.existsSync(manifestPath));

    for (const [agentName, manifestPath] of manifests) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        for (const [hostPath, containerPath] of Object.entries(manifest.volumes || {})) {
            const normalized = path.posix.normalize(hostPath);
            assert.equal(path.posix.isAbsolute(hostPath), false, `${agentName}: host volume must be workspace-relative`);
            assert.equal(normalized, hostPath, `${agentName}: host volume must already be normalized`);
            assert.equal(
                normalized.startsWith('.data/'),
                true,
                `${agentName}: writable host volume must be beneath .data: ${hostPath}`,
            );
            assert.equal(path.posix.isAbsolute(containerPath), true, `${agentName}: container volume must be absolute`);
        }
    }
});

test('stateful service manifests use their exact unique-agent storage mappings', () => {
    assert.deepEqual(readManifest('keycloak').volumes, {
        '.data/keycloak/data': '/opt/keycloak/data',
    });
    assert.deepEqual(readManifest('ollama').volumes, {
        '.data/ollama/root': '/root/.ollama',
    });
    assert.deepEqual(readManifest('postgres').volumes, {
        '.data/postgres/data': '/var/lib/postgresql/data',
    });
});

test('bwrap-runner persistent storage retains its planner-backed unique agent key', () => {
    const storage = readManifest('bwrap-runner').runtime?.resources?.persistentStorage;
    assert.deepEqual(storage, {
        key: 'bwrap-runner',
        containerPath: '/var/lib/ploinky-bwrap-runner',
        chmod: 448,
    });
});
