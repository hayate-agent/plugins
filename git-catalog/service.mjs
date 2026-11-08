/** Read-only Git discovery. No shell, clone hooks, process cwd or browser-held token. */
export class GitCatalog {
  constructor({ providers, credentials, fetch: request = fetch }) {
    if (!Array.isArray(providers)) throw Error('Explicit Git providers required');
    this.providers = providers.map(provider => {
      const origin = new URL(provider.origin);
      if (!['github', 'forgejo'].includes(provider.kind) || !/^[a-z][a-z0-9_-]*$/.test(provider.id) || origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('Invalid Git provider');
      return { ...provider, origin: origin.origin };
    });
    if (new Set(this.providers.map(p => p.id)).size !== this.providers.length) throw Error('Duplicate Git provider');
    this.credentials = credentials; this.fetch = request;
  }
  list() { return this.providers.map(({ id, kind, origin }) => ({ id, kind, origin })); }
  async #get(owner, providerId, route) {
    const provider = this.providers.find(p => p.id === providerId); if (!provider) throw Error('Git provider not found');
    const send = async token => {
      const response = await this.fetch(provider.origin + (provider.kind === 'forgejo' ? '/api/v1' : '') + route, {
        headers: { Accept: 'application/json', 'User-Agent': 'Hayate-Git-Catalog', ...(token ? { Authorization: provider.kind === 'github' ? `Bearer ${token}` : `token ${token}` } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error('Git catalog request failed');
      const data = await response.json(); if (!Array.isArray(data)) throw Error('Invalid Git catalog response'); return data;
    };
    const data = provider.credential ? await this.credentials.withSecret(owner, provider.credential, send) : await send();
    return { provider, data };
  }
  async organizations(owner, providerId, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1) throw Error('Invalid page');
    const { data } = await this.#get(owner, providerId, `/user/orgs?page=${page}&limit=50&per_page=50`);
    return { entries: data.map(value => ({ id: String(value.id), name: String(value.login ?? value.username ?? '') })).filter(v => v.name), page, hasMore: data.length === 50 };
  }
  async repositories(owner, providerId, organization, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1 || (organization !== undefined && !/^[a-zA-Z0-9_.-]+$/.test(organization))) throw Error('Invalid organization/page');
    const route = organization ? `/orgs/${encodeURIComponent(organization)}/repos` : '/user/repos';
    const { provider, data } = await this.#get(owner, providerId, `${route}?page=${page}&limit=50&per_page=50`);
    return { entries: data.map(value => ({ id: String(value.id), name: String(value.full_name ?? ''), private: value.private === true,
      // Checkout mappings are installation-owned. A remote repository name is
      // never silently treated as a local path or a permission to clone/execute.
      directory: provider.checkouts?.[value.full_name] ?? null })).filter(v => v.name), page, hasMore: data.length === 50 };
  }
}
