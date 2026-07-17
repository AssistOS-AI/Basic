import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('WebTTY pins an immutable image and requires its v5 verifier before bind', () => {
  assert.match(
    manifest.container,
    /^docker\.io\/assistos\/webtty-agent@sha256:[0-9a-f]{64}$/,
  );
  assert.equal(manifest.start, '/usr/local/bin/webtty-v5-start');
  assert.deepEqual(manifest.httpServices, [{
    slug: 'webtty',
    externalPrefix: '/services/webtty/',
    internalPrefix: '/',
    access: 'authenticated',
    port: 7681,
  }]);
});
