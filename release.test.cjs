'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classify, semver } = require('./release.cjs');

const ENGINE = path.join(__dirname, 'release.cjs');
const REPO = 'example/project';
const BOT = 'github-actions[bot]';
const EMAIL = 'github-actions[bot]@users.noreply.github.com';
const CANDIDATE_REF = 'refs/heads/automation/release-candidate';
const MARKER = '<!-- openmcp-semantic-release -->';

// Each executable runs in a separate process against one fixture's JSON state.
// There are no mocks of production internals, shared cwd, or network requests.
function fakeGh() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const statePath = process.env.RELEASE_TEST_STATE;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
  const args = process.argv.slice(2);
  const insist = (condition, message) => { if (!condition) throw new Error(message); };
  const git = (...args) => {
    const result = spawnSync(process.env.RELEASE_TEST_REAL_GIT, ['-C', process.env.RELEASE_TEST_SOURCE, ...args], {
      encoding: 'utf8', env: process.env,
    });
    insist(result.status === 0, result.stderr || 'fake publication git failed');
  };
  const publish = (item) => {
    git('tag', item.tag_name, item.target_commitish);
    git('push', 'origin', `refs/tags/${item.tag_name}`);
    item.draft = false;
    save();
  };
  const respond = (value) => { save(); if (value !== undefined) process.stdout.write(JSON.stringify(value)); };
  try {
    if (process.env.RELEASE_TEST_EXPECTED_HOST) {
      insist(process.env.GH_HOST === process.env.RELEASE_TEST_EXPECTED_HOST, 'Release API addressed the wrong GitHub instance');
    }
    if (args[0] === 'release' && args[1] === 'upload') {
      const item = state.items.find((item) => item.tag_name === args[2]);
      insist(item && item.draft, 'Assets must never be uploaded after publication');
      if (state.uploadFailures > 0) {
        state.uploadFailures--;
        save();
        throw new Error('asset upload interrupted');
      }
      const assets = args.slice(3, args.indexOf('--repo'));
      insist(assets.length > 0 && assets.every((asset) => fs.statSync(asset).isFile()), 'Missing built asset');
      const existing = state.assets[item.id] || [];
      for (const asset of assets) {
        const name = path.basename(asset);
        insist(!existing.some((entry) => entry.name === name), 'Duplicate asset upload');
        existing.push({ id: state.nextAssetId++, name, state: 'uploaded' });
      }
      state.assets[item.id] = existing;
      state.mutations.push({ method: 'upload', id: item.id, names: assets.map((asset) => path.basename(asset)) });
      respond();
      return;
    }
    insist(args[0] === 'api', `Unexpected gh command: ${args.join(' ')}`);
    const prefix = 'repos/example/project/releases';
    insist(args[1].startsWith(prefix), 'Unexpected repository API endpoint');
    const endpoint = args[1].slice(prefix.length);
    const method = args[args.indexOf('--method') + 1];
    const data = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
    if (method === 'GET' && endpoint.startsWith('?')) {
      const page = Number(new URLSearchParams(endpoint.slice(1)).get('page') || 1);
      respond(state.items.slice((page - 1) * 100, page * 100));
      return;
    }
    if (method === 'POST' && endpoint === '') {
      insist(data.draft === true, 'POST must only create a draft');
      const item = { id: Math.max(0, ...state.items.map((item) => item.id)) + 1, ...data };
      state.items.push(item);
      state.assets[item.id] = [];
      state.mutations.push({ method, id: item.id, payload: data });
      respond(item);
      return;
    }
    if (method === 'DELETE' && /^\/assets\/\d+$/.test(endpoint)) {
      const id = Number(endpoint.split('/').at(-1));
      const owner = state.items.find((item) => (state.assets[item.id] || []).some((asset) => asset.id === id));
      insist(owner && owner.draft, 'Assets must never be deleted after publication');
      state.assets[owner.id] = state.assets[owner.id].filter((asset) => asset.id !== id);
      state.mutations.push({ method, id });
      respond();
      return;
    }
    const match = endpoint.match(/^\/(\d+)(\/assets\?.*)?$/);
    insist(match, `Unexpected API endpoint: ${endpoint}`);
    const item = state.items.find((item) => item.id === Number(match[1]));
    insist(item, 'Unknown release');
    if (method === 'GET' && match[2]) {
      const page = Number(new URLSearchParams(match[2].split('?')[1]).get('page') || 1);
      respond((state.assets[item.id] || []).slice((page - 1) * 100, page * 100));
      return;
    }
    if (method === 'GET') {
      if (state.publishBeforeRead && item.draft) {
        state.publishBeforeRead = false;
        publish(item);
      }
      respond(item);
      return;
    }
    insist(method === 'PATCH', `Unexpected API method: ${method}`);
    insist(!Object.hasOwn(data, 'draft'), 'PATCH must never publish or unpublish a release');
    if (state.publishBeforePatch && item.draft) {
      state.publishBeforePatch = false;
      publish(item);
    }
    insist(item.draft, 'immutable published release');
    state.mutations.push({ method, id: item.id, payload: data });
    Object.assign(item, data);
    respond(item);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

function fakeTask() {
  const fs = require('node:fs');
  const path = require('node:path');
  const statePath = process.env.RELEASE_TEST_STATE;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const args = process.argv.slice(2);
  try {
    if (args[0] === 'release:list-nested-modules') {
      process.stdout.write(fs.existsSync('api/go.mod') ? 'api' : '');
    } else if (args[0] === 'release:set-version') {
      const version = args.at(-1);
      fs.writeFileSync('VERSION', version);
      if (!version.endsWith('-dev')) {
        fs.writeFileSync('charts/operator/Chart.yaml', `version: ${version}\nappVersion: ${version}\n`);
        fs.writeFileSync('charts/operator/values.yaml', `image:\n  tag: ${version}\n`);
        fs.writeFileSync('go.mod', `module example/project\nrequire example/project/api ${version}\n`);
      }
    } else if (args[0] === 'release:artifacts') {
      state.builds++;
      fs.writeFileSync(statePath, JSON.stringify(state));
      const version = fs.readFileSync('VERSION', 'utf8').trim();
      fs.mkdirSync('bin/release', { recursive: true });
      fs.writeFileSync(path.join('bin/release', `cli-${version}.tar.gz`), 'candidate binary');
    } else {
      throw new Error(`Unexpected task: ${args.join(' ')}`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

function fakeGit() {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const args = process.argv.slice(2);
  const statePath = process.env.RELEASE_TEST_STATE;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const realGit = process.env.RELEASE_TEST_REAL_GIT;
  const source = process.env.RELEASE_TEST_SOURCE;
  const run = (args) => spawnSync(realGit, args, { encoding: 'utf8', env: process.env });
  const checked = (args) => {
    const result = run(['-C', source, ...args]);
    if (result.status !== 0) throw new Error(result.stderr || 'competing git action failed');
    return result.stdout.trim();
  };
  try {
    // Trigger on the actual destination ref, not a particular force/lease argv spelling.
    if (state.race && args[0] === 'push' && args.some((arg) => arg.split(':').at(-1) === state.race.ref)) {
      const race = state.race;
      state.race = null;
      fs.writeFileSync(statePath, JSON.stringify(state));
      const sha = race.createAt || checked([
        'commit-tree', `${race.parent}^{tree}`, '-p', race.parent, '-m', 'fix: concurrent merge',
      ]);
      checked(['push', 'origin', `${sha}:${race.ref}`]);
      state.concurrent = sha;
      fs.writeFileSync(statePath, JSON.stringify(state));
    }
    const result = run(args);
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exitCode = result.status ?? 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

function executable(name) {
  for (const directory of process.env.PATH.split(path.delimiter)) {
    const filename = path.join(directory, name);
    try {
      fs.accessSync(filename, fs.constants.X_OK);
      if (fs.statSync(filename).isFile()) return filename;
    } catch { /* Keep looking through PATH. */ }
  }
  throw new Error(`${name} is required for release integration tests`);
}

class Fixture {
  constructor(t) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-node-test-'));
    t.after(() => fs.rmSync(this.root, { recursive: true, force: true }));
    this.source = path.join(this.root, 'source');
    this.remote = path.join(this.root, 'remote.git');
    this.bin = path.join(this.root, 'bin');
    this.statePath = path.join(this.root, 'state.json');
    this.realGit = executable('git');
    fs.mkdirSync(this.source);
    fs.mkdirSync(this.bin);
    this.env = { ...process.env };
    for (const name of Object.keys(this.env)) {
      if (name.startsWith('GIT_') || name.startsWith('GH_') || name.startsWith('GITHUB_')) delete this.env[name];
    }
    Object.assign(this.env, {
      PATH: `${this.bin}${path.delimiter}${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_TERMINAL_PROMPT: '0',
      GH_CONFIG_DIR: path.join(this.root, 'gh-config'),
      RELEASE_TEST_STATE: this.statePath,
      RELEASE_TEST_REAL_GIT: this.realGit,
      RELEASE_TEST_SOURCE: this.source,
    });
    for (const [name, implementation] of [['gh', fakeGh], ['task', fakeTask], ['git', fakeGit]]) {
      fs.writeFileSync(path.join(this.bin, name), `#!/usr/bin/env node\n(${implementation.toString()})();\n`, { mode: 0o755 });
    }
    this.git('init', '-b', 'main');
    this.git('config', 'user.name', 'Release test');
    this.git('config', 'user.email', 'release@example.test');
    this.git('config', 'commit.gpgsign', 'false');
    this.write('VERSION', 'v1.2.3-dev');
    this.write('charts/operator/Chart.yaml', 'version: v1.2.3\nappVersion: v1.2.3\n');
    this.write('charts/operator/values.yaml', 'image:\n  tag: v1.2.3\n');
    this.write('api/go.mod', 'module example/project/api\n');
    this.write('go.mod', 'module example/project\nrequire example/project/api v1.2.3\n');
    this.git('add', '.');
    const initial = this.commit('chore: initialize');
    this.git('tag', 'v1.2.3');
    this.git('init', '--bare', this.remote);
    this.git('remote', 'add', 'origin', this.remote);
    this.git('push', 'origin', 'main', '--tags');
    this.save({
      items: [{ id: 1, tag_name: 'v1.2.3', draft: false, prerelease: false,
        name: 'Release v1.2.3', body: '', target_commitish: initial }],
      assets: {}, mutations: [], builds: 0, nextAssetId: 100,
      uploadFailures: 0, publishBeforeRead: false, publishBeforePatch: false,
      race: null, concurrent: null,
    });
  }

  run(command, args, options = {}) {
    return spawnSync(command, args, { cwd: this.source, env: this.env, encoding: 'utf8', ...options });
  }

  git(...args) {
    const result = this.run(this.realGit, args);
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  write(filename, contents) {
    const destination = path.join(this.source, filename);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }

  commit(message, email = 'release@example.test') {
    this.git('-c', `user.email=${email}`, 'commit', '--allow-empty', '-m', message);
    return this.head();
  }

  head() { return this.git('rev-parse', 'HEAD'); }
  read() { return JSON.parse(fs.readFileSync(this.statePath, 'utf8')); }
  save(state) { fs.writeFileSync(this.statePath, JSON.stringify(state)); }
  update(change) { const state = this.read(); change(state); this.save(state); }
  item(id) { return this.read().items.find((item) => item.id === id); }
  mutations() { return this.read().mutations; }
  pushMain() { this.git('push', 'origin', 'main'); }

  cli(command, ...args) {
    return this.run(process.execPath, [ENGINE, command, '--repo', REPO, ...args]);
  }

  success(command, ...args) {
    const result = this.cli(command, ...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }

  failure(command, expected, ...args) {
    const result = this.cli(command, ...args);
    assert.notEqual(result.status, 0, 'CLI unexpectedly succeeded');
    assert.match(result.stderr, expected);
    assert.equal(result.stdout.trim(), '', 'Failure must not emit a success JSON document');
    return result;
  }

  plan() { this.pushMain(); return this.success('plan'); }
  prepare(isCli = false) { this.pushMain(); return this.success('draft', ...(isCli ? ['--is-cli'] : [])); }
  post(item) { return this.success('post-publish', '--release-id', String(item.id)); }
  postFailure(item, expected) { return this.failure('post-publish', expected, '--release-id', String(item.id)); }

  publish(draft) {
    const item = this.item(draft.id);
    assert.equal(item.draft, true);
    this.git('tag', item.tag_name, item.target_commitish);
    this.git('push', 'origin', `refs/tags/${item.tag_name}`);
    this.update((state) => { state.items.find((entry) => entry.id === item.id).draft = false; });
    return this.item(item.id);
  }

  refreshMain() {
    this.git('fetch', 'origin', 'main');
    this.git('merge', '--ff-only', 'origin/main');
    return this.head();
  }

  ref(ref) {
    const result = this.git('ls-remote', 'origin', ref, `${ref}^{}`);
    if (!result) return null;
    const refs = new Map(result.split('\n').map((line) => {
      const [sha, name] = line.split(/\s+/);
      return [name, sha];
    }));
    return refs.get(`${ref}^{}`) || refs.get(ref) || null;
  }

  tag(tag) { return this.ref(`refs/tags/${tag}`); }
  ancestor(older, newer) {
    const result = this.run(this.realGit, ['merge-base', '--is-ancestor', older, newer]);
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    return result.status === 0;
  }

  metadata(item) {
    const matches = [...item.body.matchAll(/<!-- openmcp-release-state: (.*?) -->/g)];
    assert.equal(matches.length, 1, 'Draft must contain exactly one state record');
    return JSON.parse(matches[0][1]);
  }

  changeMetadata(item, change) {
    const metadata = this.metadata(item);
    change(metadata);
    this.update((state) => {
      state.items.find((entry) => entry.id === item.id).body = `${MARKER}\n<!-- openmcp-release-state: ${JSON.stringify(metadata)} -->`;
    });
    return metadata;
  }
}

function integration(name, body, candidate = false) {
  test(name, { concurrency: false }, (t) => {
    const fixture = new Fixture(t);
    if (candidate) fixture.commit('fix: candidate change');
    body(fixture);
  });
}

function publication(name, body) { integration(name, body, true); }

test('semantic boundaries preserve level, kind, and complete subject', () => {
  for (const [message, expected] of [
    ['fix(api): correct status', [1, 'fix', 'fix(api): correct status']],
    ['perf: reduce allocations', [1, 'perf', 'perf: reduce allocations']],
    ['feat(api): add status', [2, 'feat', 'feat(api): add status']],
    ['refactor(api)!: remove legacy status', [3, 'refactor', 'refactor(api)!: remove legacy status']],
    ['fix: change status\n\nBREAKING CHANGE: old status removed', [3, 'fix', 'fix: change status']],
    ['chore: dependencies\n\nBREAKING-CHANGE: removed old API', [3, 'chore', 'chore: dependencies']],
    ['docs: mention feat: examples', [1, 'docs', 'docs: mention feat: examples']],
    ['Update build tooling', [1, 'other', 'Update build tooling']],
  ]) assert.deepEqual(classify(message), expected, message);
});

test('semver accepts stable root versions only', () => {
  for (const [tag, expected] of [['v0.0.0', [0, 0, 0]], ['v1.2.3', [1, 2, 3]], ['v12.34.56', [12, 34, 56]]]) {
    assert.deepEqual(semver(tag), expected);
  }
  for (const tag of ['1.2.3', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3-dev', 'v1.2.3-rc.1',
    'v1.2.3+build', 'api/v1.2.3', 'v1.2', 'v1.2.3\n', ' v1.2.3', '']) {
    assert.equal(semver(tag), null, tag);
  }
});

integration('Enterprise APIs and release-note links use the event server', (f) => {
  f.env.GITHUB_SERVER_URL = 'https://github.example.test';
  f.env.RELEASE_TEST_EXPECTED_HOST = 'github.example.test';
  f.commit('fix: Enterprise release');
  const candidate = f.plan();
  assert.match(candidate.body, /https:\/\/github\.example\.test\/example\/project\/commit\//);
  assert.match(candidate.body, /https:\/\/github\.example\.test\/example\/project\/compare\//);
  assert.doesNotMatch(candidate.body, /https:\/\/github\.com\//);
});

integration('a merged feature pull request appears once in generated notes', (f) => {
  f.git('switch', '-c', 'feat/greeting');
  f.commit('feat: add greeting feature');
  f.git('switch', 'main');
  f.git('merge', '--no-ff', '-m', 'feat: add greeting feature', 'feat/greeting');
  const candidate = f.plan();
  assert.equal(candidate.version, 'v1.3.0');
  assert.equal(candidate.commits.length, 1);
  assert.equal(candidate.commits[0].message.split('\n')[0], 'feat: add greeting feature');
  assert.equal((candidate.body.match(/add greeting feature/g) || []).length, 1);
});

integration('cumulative bump ignores drafts, prereleases, and nested releases', (f) => {
  f.commit('fix: repair old behavior');
  assert.equal(f.plan().version, 'v1.2.4');
  f.commit('feat: add supported behavior');
  f.git('tag', 'v2.0.0-rc.1');
  f.git('tag', 'api/v9.0.0');
  f.update((state) => state.items.push(
    { id: 2, tag_name: 'v7.0.0', draft: true, prerelease: false },
    { id: 3, tag_name: 'v2.0.0-rc.1', draft: false, prerelease: true },
    { id: 4, tag_name: 'api/v9.0.0', draft: false, prerelease: false },
  ));
  const candidate = f.plan();
  assert.equal(candidate.version, 'v1.3.0');
  assert.equal(candidate.previous_tag, 'v1.2.3');
  assert.match(candidate.body, /fix: repair old behavior/);
  assert.match(candidate.body, /feat: add supported behavior/);
  f.commit('fix!: remove unsupported behavior');
  assert.equal(f.plan().version, 'v2.0.0');
});

integration('bot-only release housekeeping is ignored, but identical human messages are retained', (f) => {
  const message = 'chore(release): prepare for next development iteration (version v1.2.3-dev)';
  f.commit(message, EMAIL);
  const empty = f.plan();
  assert.equal(empty.version, null);
  assert.deepEqual(empty.commits, []);
  f.commit(message);
  assert.equal(f.plan().version, 'v1.2.4');
});

integration('first release uses a zero baseline, not VERSION', (f) => {
  f.write('VERSION', 'v90.0.0-dev');
  f.git('add', 'VERSION');
  f.commit('feat: first feature');
  f.update((state) => { state.items = []; });
  const candidate = f.plan();
  assert.equal(candidate.version, 'v0.1.0');
  assert.equal(candidate.previous_tag, null);
});

integration('a published release on unrelated ancestry is not the main baseline', (f) => {
  f.git('switch', '-c', 'other');
  f.commit('feat!: unrelated branch');
  f.git('tag', 'v3.0.0');
  f.git('push', 'origin', 'refs/tags/v3.0.0');
  f.git('switch', 'main');
  f.commit('fix: main change');
  f.update((state) => state.items.push({ id: 2, tag_name: 'v3.0.0', draft: false, prerelease: false }));
  assert.equal(f.plan().version, 'v1.2.4');
});

integration('a stale checkout is rejected before planning or mutation', (f) => {
  const old = f.head();
  f.commit('fix: concurrent merge');
  f.pushMain();
  const latest = f.head();
  f.git('checkout', '--detach', old);
  f.failure('plan', /main changed|checkout is stale/);
  assert.equal(f.ref('refs/heads/main'), latest);
  assert.deepEqual(f.mutations(), []);
});

publication('draft prepares exact off-main source without changing main or tags and repeats idempotently', (f) => {
  const head = f.head();
  const draft = f.prepare();
  const metadata = f.metadata(draft);
  assert.equal(metadata.source_sha, head);
  assert.equal(metadata.release_sha, draft.target_commitish);
  assert.equal(metadata.candidate_branch, 'automation/release-candidate');
  assert.equal(f.ancestor(metadata.release_sha, head), false);
  assert.equal(f.git('show', `${metadata.release_sha}:VERSION`), 'v1.2.4');
  assert.deepEqual(metadata.nested_tags, ['api/v1.2.4']);
  assert.equal(f.head(), head);
  assert.equal(f.ref('refs/heads/main'), head);
  assert.equal(fs.readFileSync(path.join(f.source, 'VERSION'), 'utf8'), 'v1.2.3-dev');
  assert.equal(f.tag('v1.2.4'), null);
  assert.equal(f.tag('api/v1.2.4'), null);
  assert.equal(f.ref(CANDIDATE_REF), metadata.release_sha);
  const changes = f.mutations();
  const repeated = f.prepare();
  assert.deepEqual(f.metadata(repeated), metadata);
  assert.deepEqual(repeated, draft);
  assert.deepEqual(f.mutations(), changes);
});

publication('off-main published baseline uses the recorded main source', (f) => {
  const published = f.publish(f.prepare());
  assert.equal(f.ancestor(f.metadata(published).release_sha, f.head()), false);
  let candidate = f.plan();
  assert.equal(candidate.previous_tag, 'v1.2.4');
  assert.equal(candidate.version, null);
  f.commit('feat: next feature');
  candidate = f.plan();
  assert.equal(candidate.version, 'v1.3.0');
  assert.doesNotMatch(candidate.body, /candidate change/);
});

publication('post-publish merges exact tagged source, preserves newer main, then adds only a development VERSION commit', (f) => {
  const published = f.publish(f.prepare());
  f.write('new-source.txt', 'merged after candidate preparation');
  f.git('add', 'new-source.txt');
  const latest = f.commit('feat: preserve concurrent main work');
  f.pushMain();
  const changes = f.mutations();
  const result = f.post(published);
  assert.equal(result.status, 'synchronized');
  assert.equal(result.release_id, published.id);
  assert.equal(result.version, published.tag_name);
  assert.equal(result.release_sha, published.target_commitish);
  assert.equal(f.ancestor(latest, result.main_sha), true);
  assert.equal(f.ancestor(published.target_commitish, result.main_sha), true);
  const merge = f.git('rev-parse', `${result.main_sha}^`);
  assert.deepEqual(f.git('rev-list', '--parents', '-n', '1', merge).split(/\s+/), [merge, latest, published.target_commitish]);
  assert.equal(f.git('show', `${merge}:VERSION`), 'v1.2.4');
  assert.equal(f.git('diff', '--name-only', merge, result.main_sha), 'VERSION');
  assert.equal(f.tag('v1.2.4'), published.target_commitish);
  assert.equal(f.tag('api/v1.2.4'), published.target_commitish);
  assert.equal(f.git('show', 'v1.2.4:VERSION'), 'v1.2.4');
  assert.equal(f.git('show', `${result.main_sha}:VERSION`), 'v1.2.4-dev');
  assert.match(f.git('show', `${result.main_sha}:charts/operator/Chart.yaml`), /version: v1\.2\.4/);
  assert.match(f.git('show', `${result.main_sha}:charts/operator/values.yaml`), /tag: v1\.2\.4/);
  assert.match(f.git('show', `${result.main_sha}:go.mod`), /example\/project\/api v1\.2\.4/);
  assert.equal(f.git('show', `${result.main_sha}:new-source.txt`), 'merged after candidate preparation');
  assert.ok(f.git('show', '-s', '--format=%B', result.main_sha).includes(`Signed-off-by: ${BOT} <${EMAIL}>`));
  const current = f.refreshMain();
  const repeated = f.post(published);
  assert.equal(repeated.status, 'unchanged');
  assert.equal(repeated.main_sha, current);
  assert.deepEqual(f.mutations(), changes);
  assert.equal(f.plan().previous_tag, 'v1.2.4');
});

publication('merge uses the published SHA even after the candidate branch advances', (f) => {
  const published = f.publish(f.prepare());
  f.commit('feat: prepare a newer candidate');
  const newer = f.prepare();
  const result = f.post(published);
  assert.equal(f.ancestor(published.target_commitish, result.main_sha), true);
  assert.equal(f.ancestor(newer.target_commitish, result.main_sha), false);
  assert.equal(f.git('show', `${result.main_sha}:VERSION`), 'v1.2.4-dev');
  assert.equal(f.ref(CANDIDATE_REF), newer.target_commitish);
});

publication('merge conflicts preserve remote main and the published tag', (f) => {
  const published = f.publish(f.prepare());
  f.write('VERSION', 'v9.0.0-dev');
  f.git('add', 'VERSION');
  const head = f.commit('chore: conflicting version change');
  f.pushMain();
  f.postFailure(published, /merge.*failed|CONFLICT|conflict/);
  assert.equal(f.ref('refs/heads/main'), head);
  assert.equal(f.tag(published.tag_name), published.target_commitish);
  assert.equal(f.git('show', `${head}:VERSION`), 'v9.0.0-dev');
});

publication('already merged release recovery adds only the development commit', (f) => {
  const published = f.publish(f.prepare());
  f.git('merge', '--no-ff', '--no-edit', published.target_commitish);
  const head = f.head();
  f.pushMain();
  const result = f.post(published);
  assert.deepEqual(f.git('rev-list', '--parents', '-n', '1', result.main_sha).split(/\s+/), [result.main_sha, head]);
  assert.equal(f.git('show', `${result.main_sha}:VERSION`), 'v1.2.4-dev');
});

publication('nested modules come from published source, not latest main', (f) => {
  const published = f.publish(f.prepare());
  f.git('rm', 'api/go.mod');
  const latest = f.commit('refactor: remove module from newer main');
  f.pushMain();
  const result = f.post(published);
  assert.deepEqual(result.nested_tags, ['api/v1.2.4']);
  assert.equal(f.tag('api/v1.2.4'), published.target_commitish);
  assert.equal(f.ancestor(latest, result.main_sha), true);
});

publication('a real competing main push rejects synchronization without overwriting concurrent work', (f) => {
  const published = f.publish(f.prepare());
  f.update((state) => { state.race = { ref: 'refs/heads/main', parent: f.head() }; });
  f.postFailure(published, /git push.*failed|non-fast-forward|fetch first|rejected/);
  const concurrent = f.read().concurrent;
  assert.ok(concurrent, 'Competing push must actually execute');
  assert.equal(f.ref('refs/heads/main'), concurrent);
  assert.equal(f.git('show', `${concurrent}:VERSION`), 'v1.2.3-dev');
  assert.equal(f.tag(published.tag_name), published.target_commitish);
});

publication('bot-only post-publish changes never create another draft', (f) => {
  const published = f.publish(f.prepare());
  f.post(published);
  f.refreshMain();
  assert.equal(f.plan().version, null);
  const changes = f.mutations();
  const result = f.prepare();
  assert.equal(result.version, null);
  assert.deepEqual(f.mutations(), changes);
  assert.equal(f.read().items.filter((item) => item.draft).length, 0);
});

publication('stale published events never regress main VERSION', (f) => {
  const older = f.publish(f.prepare());
  f.post(older);
  f.refreshMain();
  f.commit('feat: newer release');
  const newer = f.publish(f.prepare());
  f.post(newer);
  const head = f.refreshMain();
  const result = f.post(older);
  assert.equal(result.status, 'stale');
  assert.equal(f.ref('refs/heads/main'), head);
  assert.equal(fs.readFileSync(path.join(f.source, 'VERSION'), 'utf8'), 'v1.3.0-dev');
});

publication('an unrelated candidate branch is not overwritten', (f) => {
  const head = f.head();
  f.git('push', 'origin', `${head}:${CANDIDATE_REF}`);
  f.pushMain();
  f.failure('draft', /not an automation-owned/);
  assert.equal(f.ref(CANDIDATE_REF), head);
  assert.deepEqual(f.mutations(), []);
});

publication('an explicit empty candidate lease rejects a real concurrent branch creation', (f) => {
  const head = f.head();
  f.pushMain();
  f.update((state) => { state.race = { ref: CANDIDATE_REF, createAt: head }; });
  f.failure('draft', /git push.*failed|stale info|rejected/);
  assert.equal(f.read().concurrent, head);
  assert.equal(f.ref(CANDIDATE_REF), head);
  assert.deepEqual(f.mutations(), []);
});

publication('an existing candidate lease rejects a real concurrent branch update', (f) => {
  const draft = f.prepare();
  const changes = f.mutations();
  f.commit('feat: next candidate');
  f.pushMain();
  f.update((state) => { state.race = { ref: CANDIDATE_REF, parent: draft.target_commitish }; });
  f.failure('draft', /git push.*failed|stale info|rejected/);
  const concurrent = f.read().concurrent;
  assert.ok(concurrent);
  assert.notEqual(concurrent, draft.target_commitish);
  assert.equal(f.ref(CANDIDATE_REF), concurrent);
  assert.deepEqual(f.mutations(), changes);
  assert.deepEqual(f.item(draft.id), draft);
});

publication('a published source VERSION mismatch has no main or nested-tag side effects', (f) => {
  const draft = f.prepare();
  const metadata = f.metadata(draft);
  const badSha = f.git('commit-tree', `${metadata.source_sha}^{tree}`, '-p', metadata.source_sha, '-m', 'chore: wrong version source');
  f.changeMetadata(draft, (state) => { state.release_sha = badSha; });
  f.update((state) => { state.items.find((item) => item.id === draft.id).target_commitish = badSha; });
  const published = f.publish(draft);
  const main = f.ref('refs/heads/main');
  const changes = f.mutations();
  f.postFailure(published, /VERSION does not match/);
  assert.equal(f.ref('refs/heads/main'), main);
  assert.equal(f.tag('api/v1.2.4'), null);
  assert.deepEqual(f.mutations(), changes);
});

publication('a root tag target mismatch is rejected without retagging', (f) => {
  const published = f.publish(f.prepare());
  f.changeMetadata(published, (state) => { state.release_sha = state.source_sha; });
  const actual = f.tag(published.tag_name);
  const main = f.ref('refs/heads/main');
  f.postFailure(published, /never retag/);
  assert.equal(f.tag(published.tag_name), actual);
  assert.equal(f.ref('refs/heads/main'), main);
});

publication('a conflicting nested tag is rejected without moving it', (f) => {
  const published = f.publish(f.prepare());
  const old = f.git('rev-parse', 'v1.2.3');
  f.git('tag', 'api/v1.2.4', old);
  f.git('push', 'origin', 'refs/tags/api/v1.2.4');
  const main = f.ref('refs/heads/main');
  f.postFailure(published, /never move/);
  assert.equal(f.tag('api/v1.2.4'), old);
  assert.equal(f.ref('refs/heads/main'), main);
});

publication('publication during a draft read prevents all release mutations', (f) => {
  const draft = f.prepare();
  f.commit('feat: new candidate');
  f.pushMain();
  const changes = f.mutations();
  f.update((state) => { state.publishBeforeRead = true; });
  f.failure('draft', /published during preparation/);
  assert.deepEqual(f.mutations(), changes);
  assert.equal(f.item(draft.id).draft, false);
  assert.equal(f.tag(draft.tag_name), draft.target_commitish);
});

publication('publication between a read and PATCH never unpublishes the release', (f) => {
  const draft = f.prepare();
  f.commit('feat: newer candidate');
  f.pushMain();
  const changes = f.mutations();
  f.update((state) => { state.publishBeforePatch = true; });
  f.failure('draft', /immutable published release/);
  assert.equal(f.item(draft.id).draft, false);
  assert.equal(f.tag(draft.tag_name), draft.target_commitish);
  assert.deepEqual(f.mutations(), changes);
});

publication('CLI assets are built before publication, repeat idempotently, and replace stale assets', (f) => {
  const draft = f.prepare(true);
  assert.equal(f.read().builds, 1);
  assert.deepEqual(f.read().assets[draft.id].map((item) => item.name), ['cli-v1.2.4.tar.gz']);
  assert.deepEqual(f.metadata(draft).assets, ['cli-v1.2.4.tar.gz']);
  const changes = f.mutations();
  assert.deepEqual(f.prepare(true), draft);
  assert.equal(f.read().builds, 1);
  assert.deepEqual(f.mutations(), changes);
  f.commit('feat: larger candidate');
  const updated = f.prepare(true);
  assert.equal(updated.tag_name, 'v1.3.0');
  assert.equal(f.read().builds, 2);
  assert.deepEqual(f.read().assets[updated.id].map((item) => item.name), ['cli-v1.3.0.tar.gz']);
  assert.ok(f.mutations().some((mutation) => mutation.method === 'DELETE'));
  const published = f.publish(updated);
  const beforePublish = f.mutations();
  f.post(published);
  assert.deepEqual(f.mutations(), beforePublish);
});

publication('CLI upload failure can be retried before publication on the same prepared SHA', (f) => {
  f.pushMain();
  f.update((state) => { state.uploadFailures = 1; });
  f.failure('draft', /asset upload interrupted/, '--is-cli');
  const draft = f.read().items.find((item) => item.draft && item.body.includes(MARKER));
  assert.ok(draft);
  assert.equal(draft.draft, true);
  assert.deepEqual(f.read().assets[draft.id], []);
  assert.equal(f.tag(draft.tag_name), null);
  const recovered = f.prepare(true);
  assert.equal(recovered.target_commitish, draft.target_commitish);
  assert.deepEqual(f.read().assets[draft.id].map((asset) => asset.name), ['cli-v1.2.4.tar.gz']);
});

publication('early CLI publication rejects an incomplete immutable asset manifest', (f) => {
  const draft = f.prepare(true);
  f.update((state) => { state.assets[draft.id] = []; });
  const published = f.publish(draft);
  const changes = f.mutations();
  const main = f.ref('refs/heads/main');
  f.postFailure(published, /Published CLI assets are incomplete/);
  assert.deepEqual(f.mutations(), changes);
  assert.equal(f.tag('api/v1.2.4'), null);
  assert.equal(f.ref('refs/heads/main'), main);
});
