import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPlugin } from '../src/review-plugin.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

test('formal review tool and command resolve the session workspace instead of captured startup cwd', async () => {
  const calls = [];
  const service = {
    summarize: value => value,
    status: async cwd => { calls.push(['status', cwd]); return cwd; },
    run: async (cwd, key) => { calls.push(['run', cwd, key]); return cwd; },
    assess: async cwd => { calls.push(['assess', cwd]); return cwd; },
    extendBudget: async cwd => { calls.push(['extend', cwd]); return cwd; },
  };
  let tool, command;
  reviewPlugin(service, '/startup-not-a-repo', key => key === 'a' ? '/repo-a' : '/repo-b').activate({ registerTool(value) { tool = value; }, registerCommand(value) { command = value; } });
  assert.equal(await tool.execute({ action: 'status' }, { sessionKey: 'a' }), '/repo-a');
  assert.equal(await tool.execute({ action: 'run' }, { sessionKey: 'b' }), '/repo-b');
  assert.equal(await tool.execute({ action: 'status' }, { sessionKey: 'a', cwd: '/host-resolved' }), '/host-resolved');
  assert.equal(await command.run('status', { sessionKey: 'b' }), '/repo-b');
  assert.equal(await command.run('extend id 1 base fingerprint reason', { sessionKey: 'a' }), '/repo-a');
  assert.equal(calls.some(call => call[1] === '/startup-not-a-repo'), false);
});

test('real formal review uses two independent Git changesets while the startup cwd is not a repository', { skip: !process.env.HARNESS_CORE_ROOT }, async t => {
  const core = path.resolve(process.env.HARNESS_CORE_ROOT);
  const load = file => import(pathToFileURL(path.join(core, file)).href);
  const { git } = await load('src/changeset.ts');
  const { ReviewService } = await load('src/builtin-plugins/review.js');
  const { reviewConfig } = await load('src/review-config.ts');
  const { testReviewExecution } = await load('test/review-test-executor.ts');
  const home = await mkdtemp(path.join(os.tmpdir(), 'workspace-formal-review-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const roots = ['a', 'b'].map(name => path.join(home, name));
  const backend = { async review() { return '{"findings":[]}'; } };
  const service = new ReviewService(home, reviewConfig({ enabled: true, mandatory: { publish: true } }), backend, async () => {}, testReviewExecution(backend));
  for (const root of roots) {
    await mkdir(root); await git(root, ['init']); await git(root, ['config', 'user.name', 'Fixture']);
    await git(root, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(root, 'code.ts'), 'export const version = 1;\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'Base']);
    await service.prepare(root); await writeFile(path.join(root, 'code.ts'), 'export const version = 2;\n');
  }
  let tool;
  reviewPlugin(service, home, key => roots[key === 'a' ? 0 : 1]).activate({ registerTool(value) { tool = value; }, registerCommand() {} });
  await Promise.all(['a', 'b'].map(sessionKey => tool.execute({ action: 'run' }, { sessionKey })));
  for (const root of roots) { const state = await service.status(root); assert.equal(state.root, root); assert.equal(state.status, 'passed'); await service.assertAllowed(root, 'publish'); }
});
