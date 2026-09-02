import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COPIED_SYSTEM_FILES, MAX_SYSTEM_FILE_BYTES, stageSystemFiles } from '../../bwrap-runner/lib/system-files.mjs';
import { buildBwrapArgs, validateInput } from '../../bwrap-runner/lib/policy.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-system-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sourceRoot = path.join(root, 'source');
    const temporaryRoot = path.join(root, 'private');
    fs.mkdirSync(path.join(sourceRoot, 'etc'), { recursive: true });
    fs.mkdirSync(temporaryRoot);
    fs.writeFileSync(path.join(sourceRoot, 'etc/hosts'), '127.0.0.1 localhost\n');
    fs.writeFileSync(path.join(sourceRoot, 'etc/resolv.conf'), 'nameserver 192.0.2.1\n');
    return { root, sourceRoot, temporaryRoot };
}

test('fixed system files are isolated byte copies with fixed read-only destinations and explicit cleanup', (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.sourceRoot, 'etc/sibling-secret'), 'never copied');
    const staged = stageSystemFiles(f);
    assert.equal(fs.statSync(staged.directory).mode & 0o777, 0o700);
    assert.deepEqual([...staged.sources.keys()], COPIED_SYSTEM_FILES);
    for (const [destination, source] of staged.sources) {
        assert.deepEqual(fs.readFileSync(source), fs.readFileSync(path.join(f.sourceRoot, destination)));
        assert.equal(fs.lstatSync(source).isFile(), true);
        assert.equal(fs.statSync(source).mode & 0o777, 0o444);
    }
    fs.writeFileSync(path.join(f.sourceRoot, 'etc/hosts'), 'later OCI change');
    assert.equal(fs.readFileSync(staged.sources.get('/etc/hosts'), 'utf8'), '127.0.0.1 localhost\n');
    const args = buildBwrapArgs(validateInput({ command: 'true' }), {
        workDir: '/tmp/work', procMode: 'empty',
        existingSystemPaths: new Set(COPIED_SYSTEM_FILES), systemFileSources: staged.sources,
    });
    for (const destination of COPIED_SYSTEM_FILES) {
        const index = args.indexOf(staged.sources.get(destination));
        assert.deepEqual(args.slice(index - 1, index + 2), ['--ro-bind', staged.sources.get(destination), destination]);
    }
    assert.equal(args.includes(path.join(f.sourceRoot, 'etc/sibling-secret')), false);
    staged.cleanup();
    staged.cleanup();
    assert.equal(fs.existsSync(staged.directory), false);
});

test('unsafe or oversized fixed sources fail closed and remove partial private copies', (t) => {
    const f = fixture(t);
    fs.rmSync(path.join(f.sourceRoot, 'etc/hosts'));
    fs.mkdirSync(path.join(f.sourceRoot, 'etc/hosts'));
    assert.throws(() => stageSystemFiles(f), /unsafe or oversized/);
    assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);
    fs.rmSync(path.join(f.sourceRoot, 'etc/hosts'), { recursive: true });
    fs.writeFileSync(path.join(f.sourceRoot, 'etc/hosts'), Buffer.alloc(MAX_SYSTEM_FILE_BYTES + 1));
    assert.throws(() => stageSystemFiles(f), /unsafe or oversized/);
    assert.deepEqual(fs.readdirSync(f.temporaryRoot), []);
});

test('normal system symlinks are copied as regular files and missing optional files are omitted', (t) => {
    const f = fixture(t);
    fs.renameSync(path.join(f.sourceRoot, 'etc/resolv.conf'), path.join(f.sourceRoot, 'etc/resolver'));
    fs.symlinkSync('resolver', path.join(f.sourceRoot, 'etc/resolv.conf'));
    fs.rmSync(path.join(f.sourceRoot, 'etc/hosts'));
    const staged = stageSystemFiles(f);
    assert.deepEqual([...staged.sources.keys()], ['/etc/resolv.conf']);
    assert.equal(fs.lstatSync(staged.sources.get('/etc/resolv.conf')).isSymbolicLink(), false);
    staged.cleanup();
});

test('policy never falls back to binding the original OCI network mount or accepting caller source paths', () => {
    const input = validateInput({ command: 'true' });
    assert.throws(() => buildBwrapArgs(input, {
        workDir: '/tmp/work', procMode: 'empty', existingSystemPaths: new Set(['/etc/hosts']),
    }), /systemFileSources/);
    assert.throws(() => validateInput({ command: 'true', systemFileSources: { '/etc/hosts': '/etc/shadow' } }),
        (error) => error.code === 'BWRAP_RUNNER_INVALID_INPUT');
});
