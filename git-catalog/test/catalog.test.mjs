import test from 'node:test';
import assert from 'node:assert/strict';
import { GitCatalog } from '../service.mjs';

test('Git inventory is headless, uses scoped vault callbacks, refuses redirects and never invents a local cwd', async () => {
  const requests = [], scopes = [];
  const catalog = new GitCatalog({ providers: [{ id: 'forge', kind: 'forgejo', origin: 'https://git.example', credential: 'credential-id', checkouts: { 'org/checked-out': '/srv/work/repository' } }],
    credentials: { async withSecret(owner, id, consume) { scopes.push({ owner, id }); return consume('PRIVATE_GIT_TOKEN'); } },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => url.includes('/user/orgs') ? [{ id: 1, username: 'org' }] : [{ id: 2, full_name: 'org/checked-out', private: true }, { id: 3, full_name: 'org/not-local' }] }; },
  });
  assert.equal((await catalog.organizations('operator', 'forge')).entries[0].name, 'org');
  const repositories = await catalog.repositories('operator', 'forge', 'org');
  assert.equal(repositories.entries[0].directory, '/srv/work/repository'); assert.equal(repositories.entries[1].directory, null);
  assert.doesNotMatch(JSON.stringify(repositories), /PRIVATE_GIT_TOKEN|credential-id/);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, 'token PRIVATE_GIT_TOKEN');
  assert.deepEqual(scopes[0], { owner: 'operator', id: 'credential-id' });
  assert.throws(() => new GitCatalog({ providers: [{ id: 'bad', kind: 'github', origin: 'https://user:pass@git.example' }] }), /Invalid/);
  await assert.rejects(catalog.repositories('operator', 'forge', '../escape'), /Invalid/);
});
