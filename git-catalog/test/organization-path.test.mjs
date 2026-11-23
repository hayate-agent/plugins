import test from 'node:test';
import assert from 'node:assert/strict';
import { GitCatalog } from '../service.mjs';

for (const kind of ['github', 'forgejo']) {
  test(`${kind} rejects dot-segment organizations before credentials or fetch`, async () => {
    let credentials = 0, requests = 0;
    const catalog = new GitCatalog({ providers: [{ id: 'test', kind, origin: 'https://git.invalid', credential: 'test' }],
      credentials: { withSecret() { credentials++; throw Error('Unexpected credential lookup'); } },
      fetch: async () => { requests++; throw Error('Unexpected request'); } });
    for (const organization of ['.', '..']) await assert.rejects(catalog.repositories('owner', 'test', organization), /Invalid organization/);
    assert.equal(credentials, 0); assert.equal(requests, 0);
  });
  test(`${kind} retains ordinary names, embedded dots, and no-organization listing`, async () => {
    const paths = [];
    const catalog = new GitCatalog({ providers: [{ id: 'test', kind, origin: 'https://git.invalid' }],
      fetch: async url => { paths.push(new URL(url).pathname); return { ok: true, json: async () => [] }; } });
    const prefix = kind === 'forgejo' ? '/api/v1' : '';
    for (const organization of ['team', '.team', 'team.', 'a.b']) {
      await catalog.repositories('owner', 'test', organization);
      assert.equal(paths.at(-1), `${prefix}/orgs/${organization}/repos`);
    }
    await catalog.repositories('owner', 'test'); assert.equal(paths.at(-1), `${prefix}/user/repos`);
  });
}
