import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readManifest(agentName) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, agentName, 'manifest.json'), 'utf8'));
}

function assertManifestStorage(manifest, agentName) {
    const sections = [['root', manifest], ...Object.entries(manifest.profiles || {})];
    for (const [profileName, section] of sections) {
        const label = `${agentName}/${profileName}`;
        for (const [hostPath, containerPath] of Object.entries(section?.volumes || {})) {
            const normalized = path.posix.normalize(hostPath);
            assert.equal(path.posix.isAbsolute(hostPath), false, `${label}: host volume must be workspace-relative`);
            assert.equal(normalized, hostPath, `${label}: host volume must already be normalized`);
            assert.equal(
                normalized.startsWith('.data/'),
                true,
                `${label}: writable host volume must be beneath .data: ${hostPath}`,
            );
            assert.equal(path.posix.isAbsolute(containerPath), true, `${label}: container volume must be absolute`);
        }
    }
}

test('all manifest-declared writable host volumes are positively classified beneath .data', () => {
    const manifests = fs.readdirSync(repoRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => [entry.name, path.join(repoRoot, entry.name, 'manifest.json')])
        .filter(([, manifestPath]) => fs.existsSync(manifestPath));

    for (const [agentName, manifestPath] of manifests) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        assertManifestStorage(manifest, agentName);
    }
});

test('the storage inventory rejects profile-only violations with or without root volumes', () => {
    for (const profileName of ['default', 'dev', 'qa', 'prod']) {
        for (const root of [{}, { volumes: { '.data/demo/root': '/data' } }]) {
            for (const hostPath of ['.ploinky/data/demo', '.ploinky/shared', 'demo-data', '.data/../escaped']) {
                assert.throws(() => assertManifestStorage({
                    ...root,
                    profiles: { [profileName]: { volumes: { [hostPath]: '/cache' } } },
                }, 'demo'), { code: 'ERR_ASSERTION' });
            }
            assert.doesNotThrow(() => assertManifestStorage({
                ...root,
                profiles: { [profileName]: { volumes: { '.data/demo/cache': '/cache' } } },
            }, 'demo'));
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
