#!/usr/bin/env node
'use strict';

// Prepare semantic release drafts; post-process releases published in GitHub's UI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MARKER = '<!-- openmcp-semantic-release -->';
const STATE = /<!-- openmcp-release-state: ([^\n]*?) -->/g;
const WARNING = 'Review this candidate, then open **GitHub Releases > this draft > Publish release**. '
  + 'The draft targets prepared, exact-version source; publication creates its root tag. '
  + 'Do not change the tag or target commit, and wait for draft preparation to succeed before publishing.';
const BOT = 'github-actions[bot]';
const EMAIL = 'github-actions[bot]@users.noreply.github.com';
const CANDIDATE_BRANCH = 'automation/release-candidate';
const OWNER_TRAILER = 'OpenMCP-Release-Candidate: ';
// Unlike $, the final assertion cannot accept a trailing newline.
const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
const SHA = /^[0-9a-f]{40,64}(?![\s\S])/;
const HEADER = /^([a-z]+)(?:\([^\r\n)]+\))?(!)?: (.+)(?![\s\S])/;
const BOT_SUBJECT = /^chore\(release\): (?:(?:release|merge) v\d+\.\d+\.\d+|prepare for next development iteration \(version v\d+\.\d+\.\d+-dev\))(?![\s\S])/;
const MAX_BUFFER = 64 * 1024 * 1024;

function execute(args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    ...options,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) {
    throw new Error(`${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`${args.join(' ')} failed: terminated by ${result.signal}`);
  }
  return result;
}

function run(args, options = {}) {
  const result = execute(args, options);
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed: ${result.stderr.replace(/\r\n?/g, '\n').trim()}`);
  }
  return result.stdout.replace(/\r\n?/g, '\n').trim();
}

function git(args, options = {}) {
  return run(['git', ...args], options);
}

function api(repo, method, endpoint = '', data = null) {
  const args = ['gh', 'api', `repos/${repo}/releases${endpoint}`, '--method', method];
  if (data !== null) {
    args.push('--input', '-');
  }
  const response = run(args, data !== null ? { input: JSON.stringify(data) } : {});
  return response ? JSON.parse(response) : null;
}

function releases(repo) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const batch = api(repo, 'GET', `?per_page=100&page=${page}`);
    result.push(...batch);
    if (batch.length < 100) {
      return result;
    }
  }
}

function semver(tag) {
  if (typeof tag !== 'string') {
    return null;
  }
  const match = VERSION.exec(tag);
  if (!match) {
    return null;
  }
  const version = match.slice(1).map(Number);
  if (!version.every(Number.isSafeInteger)) {
    throw new Error(`Version ${tag} has a component outside the safe integer range.`);
  }
  return version;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function ancestor(older, newer) {
  const result = execute(['git', 'merge-base', '--is-ancestor', older, newer]);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.trim());
  }
  return result.status === 0;
}

function splitLines(value) {
  if (!value) {
    return [];
  }
  const lines = value.split(/\r\n|[\n\r\v\f\x1c-\x1e\u0085\u2028\u2029]/u);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

function classify(message) {
  const subject = splitLines(message)[0];
  if (subject === undefined) {
    throw new Error('Commit message has no subject.');
  }
  const header = HEADER.exec(subject);
  const breaking = Boolean((header && header[2]) || /(?:^|\n)BREAKING[ -]CHANGE:\s*\S/u.test(message));
  const kind = header ? header[1] : 'other';
  return [breaking ? 3 : kind === 'feat' ? 2 : 1, kind, subject];
}

function commitsSince(base, head) {
  const revision = base ? `${base}..${head}` : head;
  const fields = git(['log', '--reverse', '--format=%H%x00%ae%x00%B%x00', revision]).split('\0');
  const result = [];
  for (let index = 0; index < fields.length - 2; index += 3) {
    const sha = fields[index];
    const author = fields[index + 1];
    const message = fields[index + 2].trim();
    if (author === EMAIL && BOT_SUBJECT.test(splitLines(message)[0])) {
      continue;
    }
    result.push({ sha: sha.trim(), message });
  }
  return result;
}

function stateOf(item) {
  const matches = [...((item && item.body) || '').matchAll(STATE)];
  if (matches.length > 1) {
    throw new Error('Release has multiple candidate metadata records.');
  }
  return matches.length ? JSON.parse(matches[0][1]) : null;
}

function nonempty(value) {
  if (!value) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length !== 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length !== 0;
  }
  return true;
}

function sameList(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function stateJson(state) {
  // Keep the sorted, ASCII JSON spelling so existing drafts remain idempotent.
  const quote = value => JSON.stringify(value).replace(/[\u0080-\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const fields = Object.keys(state).sort().map(key => {
    const value = state[key];
    const encoded = Array.isArray(value) ? `[${value.map(quote).join(', ')}]` : quote(value);
    return `${quote(key)}: ${encoded}`;
  });
  return `{${fields.join(', ')}}`;
}

function candidateState(item) {
  const state = stateOf(item);
  if (!nonempty(state)) {
    return null;
  }
  if (state.version !== item.tag_name || semver(state.version || '') === null
      || typeof state.source_sha !== 'string' || !SHA.test(state.source_sha)
      || typeof state.release_sha !== 'string' || !SHA.test(state.release_sha)
      || state.candidate_branch !== CANDIDATE_BRANCH || !Array.isArray(state.nested_tags)) {
    throw new Error('Release candidate metadata does not match the release.');
  }
  for (const tag of state.nested_tags) {
    if (typeof tag !== 'string' || !tag.endsWith(`/${state.version}`)) {
      throw new Error('Release candidate has invalid nested tag metadata.');
    }
    git(['check-ref-format', `refs/tags/${tag}`]);
  }
  if (!sameList(state.nested_tags, [...new Set(state.nested_tags)].sort())) {
    throw new Error('Release candidate nested tags must be unique and sorted.');
  }
  return state;
}

function validateSource(state) {
  const sha = state.release_sha;
  if (git(['show', `${sha}:VERSION`]).trim() !== state.version) {
    throw new Error('Prepared source VERSION does not match the release version.');
  }
  const parents = git(['rev-list', '--parents', '-n', '1', sha]).split(/\s+/u).slice(1);
  if (!sameList(parents, [state.source_sha])) {
    throw new Error('Prepared source does not have the recorded main commit as its sole parent.');
  }
}

function plan(repo, published, head) {
  let baseline = [0, 0, 0];
  let previous = null;
  let base = null;
  for (const item of published) {
    const version = semver(item.tag_name);
    if (item.draft || item.prerelease || version === null) {
      continue;
    }
    const tag = item.tag_name;
    const sha = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
    const state = candidateState(item);
    let candidateBase;
    if (state) {
      if (sha !== state.release_sha) {
        throw new Error(`Published tag ${tag} does not point at its prepared source; never retag it.`);
      }
      validateSource(state);
      candidateBase = state.source_sha;
    } else {
      candidateBase = sha;
    }
    if (ancestor(candidateBase, head)
        && (previous === null || compareVersions(version, baseline) > 0
          || (compareVersions(version, baseline) === 0
            && (tag > previous || (tag === previous && candidateBase > base))))) {
      baseline = version;
      previous = tag;
      base = candidateBase;
    }
  }
  const commits = commitsSince(base, head);
  if (!commits.length) {
    return { version: null, previous_tag: previous, target_commitish: head, commits: [] };
  }
  let bump = 0;
  for (const item of commits) {
    bump = Math.max(bump, classify(item.message)[0]);
  }
  const next = bump === 3 ? [baseline[0] + 1, 0, 0]
    : bump === 2 ? [baseline[0], baseline[1] + 1, 0]
      : [baseline[0], baseline[1], baseline[2] + 1];
  if (!next.every(Number.isSafeInteger)) {
    throw new Error('Next release version has a component outside the safe integer range.');
  }
  const version = `v${next.join('.')}`;
  const sections = { 'Breaking changes': [], Features: [], Fixes: [], 'Other changes': [] };
  for (const item of commits) {
    const [level, kind, subject] = classify(item.message);
    const section = level === 3 ? 'Breaking changes' : kind === 'feat' ? 'Features'
      : kind === 'fix' || kind === 'perf' ? 'Fixes' : 'Other changes';
    let entry = `- ${subject} ([${item.sha.slice(0, 7)}](https://github.com/${repo}/commit/${item.sha}))`;
    if (level === 3 && item.message.includes('\n')) {
      entry += `\n${splitLines(item.message).slice(1).map(line => `  ${line}`).join('\n')}`;
    }
    sections[section].push(entry);
  }
  const notes = [MARKER, WARNING];
  for (const [name, entries] of Object.entries(sections)) {
    if (entries.length) {
      notes.push(`## ${name}\n\n${entries.join('\n')}`);
    }
  }
  if (previous) {
    notes.push(`**Full changelog:** https://github.com/${repo}/compare/${previous}...${head}`);
  }
  return { version, previous_tag: previous, target_commitish: head, commits, body: `${notes.join('\n\n')}\n` };
}

function managedDraft(items) {
  const drafts = items.filter(item => item.draft && (item.body || '').includes(MARKER));
  if (drafts.length > 1) {
    throw new Error('Multiple managed drafts found. Keep one managed draft before rerunning.');
  }
  return drafts.length ? drafts[0] : null;
}

function remoteRefs(...refs) {
  const result = new Map();
  for (const line of splitLines(git(['ls-remote', 'origin', ...refs]))) {
    const [sha, ref] = line.split(/\s+/u);
    result.set(ref, sha);
  }
  return result;
}

function ensureMain(head) {
  if (remoteRefs('refs/heads/main').get('refs/heads/main') !== head) {
    throw new Error('main changed or checkout is stale. Rerun on latest main; no branch was overwritten.');
  }
}

function tagTarget(tag) {
  const ref = `refs/tags/${tag}`;
  const refs = remoteRefs(ref, `${ref}^{}`);
  return refs.get(`${ref}^{}`) ?? refs.get(ref) ?? null;
}

function readDraft(repo, draft) {
  const current = api(repo, 'GET', `/${draft.id}`);
  if (!current.draft) {
    throw new Error('The draft was published during preparation. Rerun on latest main; the published release was not modified.');
  }
  if (current.tag_name !== draft.tag_name || current.body !== draft.body
      || current.target_commitish !== draft.target_commitish) {
    throw new Error('The draft changed during preparation. Rerun rather than overwrite another edit.');
  }
  return current;
}

function requireUntagged(version) {
  if (tagTarget(version) !== null) {
    throw new Error(`Tag ${version} already exists. Never change its target or overwrite it.`);
  }
}

function upsert(repo, items, draft, candidate) {
  const version = candidate.version;
  if (items.some(item => item.tag_name === version && (!draft || item.id !== draft.id))) {
    throw new Error(`Release ${version} already exists outside the managed draft.`);
  }
  const payload = { tag_name: version, name: `Release ${version}`,
    target_commitish: candidate.target_commitish, body: candidate.body, prerelease: false };
  if (draft) {
    const current = readDraft(repo, draft);
    requireUntagged(current.tag_name);
    requireUntagged(version);
    if (Object.entries(payload).every(([key, value]) => current[key] === value)) {
      return current;
    }
    // Publish may race this PATCH; omitting draft prevents unpublishing the release.
    return api(repo, 'PATCH', `/${draft.id}`, payload);
  }
  requireUntagged(version);
  return api(repo, 'POST', '', { ...payload, draft: true });
}

function sourceWorktree(sha, action) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-source-'));
  const worktree = path.join(directory, 'source');
  try {
    git(['worktree', 'add', '--detach', worktree, sha]);
    try {
      git(['submodule', 'update', '--init', '--recursive'], { cwd: worktree });
      return action(worktree);
    } finally {
      git(['worktree', 'remove', '--force', worktree]);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function isFile(filename) {
  try {
    return fs.statSync(filename).isFile();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
}

function nestedTags(version, cwd) {
  const output = run(['task', 'release:list-nested-modules'], { cwd });
  const modules = [...new Set(output ? output.split(/\s+/u) : [])].sort();
  const tags = [];
  for (const module of modules) {
    if (path.isAbsolute(module) || module.split('/').includes('..')
        || !isFile(path.join(cwd, module, 'go.mod'))) {
      throw new Error(`Configured nested module ${module} is not a real relative Go module.`);
    }
    const tag = `${module}/${version}`;
    git(['check-ref-format', `refs/tags/${tag}`]);
    tags.push(tag);
  }
  return tags;
}

function setVersion(version, cwd) {
  run(['task', 'release:set-version', '--', version], { cwd });
  if (fs.readFileSync(path.join(cwd, 'VERSION'), 'utf8').trim() !== version) {
    throw new Error('release:set-version did not set VERSION to the requested version.');
  }
}

function commit(message, cwd) {
  git(['-c', `user.name=${BOT}`, '-c', `user.email=${EMAIL}`, '-c', 'commit.gpgsign=false',
    'commit', '--signoff', '--allow-empty', '-m', message], { cwd });
  return git(['rev-parse', 'HEAD'], { cwd });
}

function ownedCandidate(sha) {
  git(['fetch', 'origin', `refs/heads/${CANDIDATE_BRANCH}`]);
  const details = git(['show', '-s', '--format=%ae%n%B', sha]);
  const separator = details.indexOf('\n');
  const author = details.slice(0, separator);
  const message = details.slice(separator + 1);
  const match = /(?:^|\n)OpenMCP-Release-Candidate: ([0-9a-f]{40,64})(?=\n|(?![\s\S]))/.exec(message);
  const version = git(['show', `${sha}:VERSION`]).trim();
  if (author !== EMAIL || !match || semver(version) === null
      || splitLines(message)[0] !== `chore(release): release ${version}`) {
    throw new Error(`${CANDIDATE_BRANCH} is not an automation-owned candidate branch; it was not overwritten.`);
  }
  const state = { release_sha: sha, source_sha: match[1], version };
  validateSource(state);
  return state;
}

function buildArtifacts(cwd) {
  run(['task', 'release:artifacts'], { cwd });
  const directory = path.join(cwd, 'bin/release');
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      throw error;
    }
    entries = [];
  }
  const assets = entries.map(entry => path.join(directory, entry)).filter(isFile)
    .map(filename => fs.realpathSync(filename)).sort();
  if (!assets.length) {
    throw new Error('CLI artifact generation produced no release assets.');
  }
  return assets;
}

function releaseAssets(repo, releaseId) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const batch = api(repo, 'GET', `/${releaseId}/assets?per_page=100&page=${page}`);
    result.push(...batch);
    if (batch.length < 100) {
      return result;
    }
  }
}

function clearAssets(repo, draft) {
  for (const asset of releaseAssets(repo, draft.id)) {
    readDraft(repo, draft);
    requireUntagged(draft.tag_name);
    api(repo, 'DELETE', `/assets/${asset.id}`);
  }
}

function prepareDraft(repo, items, draft, candidate, head, isCli) {
  if (git(['status', '--porcelain'])) {
    throw new Error('Draft preparation requires a clean checkout.');
  }
  if (draft) {
    draft = readDraft(repo, draft);
    requireUntagged(draft.tag_name);
  }
  requireUntagged(candidate.version);
  const ref = `refs/heads/${CANDIDATE_BRANCH}`;
  const oldSha = remoteRefs(ref).get(ref) ?? null;
  const oldState = candidateState(draft);
  let reusable = null;
  if (oldSha) {
    const owned = ownedCandidate(oldSha);
    if (!ancestor(owned.source_sha, head)) {
      throw new Error('Candidate branch source is not on main; it was not overwritten.');
    }
    if (oldState && oldSha !== oldState.release_sha) {
      // A previous candidate push may have succeeded before its draft update failed.
      if (!ancestor(oldState.source_sha, owned.source_sha)) {
        throw new Error('Candidate branch diverged from its managed draft; it was not overwritten.');
      }
    }
    if (owned.source_sha === head && owned.version === candidate.version) {
      reusable = oldSha;
    }
  }
  return sourceWorktree(reusable || head, worktree => {
    let releaseSha;
    if (reusable) {
      releaseSha = reusable;
    } else {
      setVersion(candidate.version, worktree);
      git(['add', '--update'], { cwd: worktree });
      releaseSha = commit(`chore(release): release ${candidate.version}\n\n${OWNER_TRAILER}${head}`, worktree);
    }
    const state = { source_sha: head, release_sha: releaseSha, version: candidate.version,
      nested_tags: nestedTags(candidate.version, worktree), candidate_branch: CANDIDATE_BRANCH };
    validateSource(state);
    const sameSource = oldState !== null && oldState.release_sha === releaseSha;
    let assets = [];
    let completeAssets = false;
    if (isCli && sameSource && nonempty(oldState.assets)) {
      const present = releaseAssets(repo, draft.id);
      completeAssets = sameList(present.map(item => item.name).sort(), oldState.assets)
        && present.every(item => item.state === undefined || item.state === 'uploaded');
    }
    if (isCli) {
      assets = completeAssets ? oldState.assets : buildArtifacts(worktree);
      state.assets = completeAssets ? assets : assets.map(asset => path.basename(asset)).sort();
    }
    ensureMain(head);
    if (draft) {
      readDraft(repo, draft);
    }
    requireUntagged(candidate.version);
    if (oldSha !== releaseSha) {
      git(['push', `--force-with-lease=${ref}:${oldSha || ''}`, 'origin', `${releaseSha}:${ref}`]);
    }
    // Clear old-version assets while the draft still targets its old source.
    if (draft && (!sameSource || (isCli && !completeAssets)
        || (!isCli && oldState && nonempty(oldState.assets)))) {
      clearAssets(repo, draft);
    }
    const prepared = { ...candidate, target_commitish: releaseSha,
      body: `${candidate.body}\n<!-- openmcp-release-state: ${stateJson(state)} -->\n` };
    draft = upsert(repo, items, draft, prepared);
    if (isCli && !completeAssets) {
      readDraft(repo, draft);
      requireUntagged(draft.tag_name);
      run(['gh', 'release', 'upload', draft.tag_name, ...assets, '--repo', repo]);
      const actual = releaseAssets(repo, draft.id);
      if (!sameList(actual.map(item => item.name).sort(), state.assets)
          || actual.some(item => item.state !== undefined && item.state !== 'uploaded')) {
        throw new Error('Draft assets do not match this candidate. Rerun draft preparation before publishing.');
      }
    }
    return draft;
  });
}

function pushNestedTags(state) {
  const missing = [];
  for (const tag of state.nested_tags) {
    const target = tagTarget(tag);
    if (target !== null && target !== state.release_sha) {
      throw new Error(`Tag ${tag} conflicts with prepared source; never move it.`);
    }
    if (target === null) {
      missing.push(tag);
    }
  }
  if (missing.length) {
    // Only missing, lightweight module tags are created. The UI owns the root tag.
    git(['push', '--atomic', 'origin', ...missing.map(tag => `${state.release_sha}:refs/tags/${tag}`)]);
  }
}

function postPublish(repo, releaseId, head) {
  const item = api(repo, 'GET', `/${releaseId}`);
  if (item.draft || item.prerelease || semver(item.tag_name) === null) {
    throw new Error('post-publish requires an actual published stable root release.');
  }
  const state = candidateState(item);
  if (!state) {
    throw new Error('Published release has no prepared candidate metadata; legacy releases are baselines only.');
  }
  if (tagTarget(item.tag_name) !== state.release_sha) {
    throw new Error('Published root tag does not point at the prepared source; never retag it.');
  }
  git(['fetch', 'origin', `refs/tags/${item.tag_name}`]);
  validateSource(state);
  if (!ancestor(state.source_sha, head)) {
    throw new Error("Recorded release source is not in main's history.");
  }
  sourceWorktree(state.release_sha, worktree => {
    if (!sameList(nestedTags(state.version, worktree), state.nested_tags)) {
      throw new Error('Recorded nested tags do not match real modules in the published source.');
    }
  });
  if (nonempty(state.assets)) {
    const actual = releaseAssets(repo, item.id);
    if (!sameList(actual.map(asset => asset.name).sort(), state.assets)
        || actual.some(asset => asset.state !== undefined && asset.state !== 'uploaded')) {
      throw new Error('Published CLI assets are incomplete or stale. Publication must wait for successful draft preparation.');
    }
  }
  pushNestedTags(state);
  const result = { release_id: item.id, version: state.version, release_sha: state.release_sha,
    nested_tags: state.nested_tags, main_sha: head };
  const latest = plan(repo, releases(repo), head);
  if (latest.previous_tag !== state.version) {
    return { ...result, status: 'stale' };
  }
  ensureMain(head);
  return sourceWorktree(head, worktree => {
    if (!ancestor(state.release_sha, head)) {
      git(['-c', `user.name=${BOT}`, '-c', `user.email=${EMAIL}`, '-c', 'commit.gpgsign=false',
        'merge', '--no-ff', '--no-edit', '--signoff', '-m',
        `chore(release): merge ${state.version}`, state.release_sha], { cwd: worktree });
    }
    setVersion(`${state.version}-dev`, worktree);
    git(['add', '--', 'VERSION'], { cwd: worktree });
    const difference = execute(['git', 'diff', '--cached', '--quiet'], { cwd: worktree });
    if (difference.status !== 0 && difference.status !== 1) {
      throw new Error(difference.stderr.trim());
    }
    if (difference.status === 0) {
      return { ...result, status: 'unchanged' };
    }
    const mainSha = commit(`chore(release): prepare for next development iteration (version ${state.version}-dev)`, worktree);
    ensureMain(head);
    // Ordinary FF push: an intervening main push must reject it, never force it.
    git(['push', 'origin', `${mainSha}:refs/heads/main`]);
    return { ...result, main_sha: mainSha, status: 'synchronized' };
  });
}

const USAGE = 'usage: release.cjs [-h] [--repo REPO] [--is-cli] [--release-id RELEASE_ID]\n'
  + '                   {plan,draft,post-publish}\n';

function argumentError(message) {
  process.stderr.write(`${USAGE}release.cjs: error: ${message}\n`);
  process.exit(2);
}

function parseArguments(argv) {
  const args = { command: null, repo: process.env.GITHUB_REPOSITORY, is_cli: false, release_id: null };
  const positions = [];
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--' && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !argument.startsWith('-') || argument === '-') {
      positions.push(argument);
      continue;
    }
    if (argument === '-h' || argument === '--help') {
      process.stdout.write(`${USAGE}\nPrepare semantic release drafts; post-process releases published in GitHub's UI.\n\n`
        + 'positional arguments:\n  {plan,draft,post-publish}\n\n'
        + 'options:\n  -h, --help            show this help message and exit\n'
        + '  --repo REPO\n  --is-cli\n  --release-id RELEASE_ID\n');
      process.exit(0);
    }
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const matching = ['--repo', '--is-cli', '--release-id', '--help'].filter(option => option.startsWith(name));
    if (!name.startsWith('--') || matching.length === 0) {
      argumentError(`unrecognized arguments: ${argument}`);
    }
    if (matching.length > 1) {
      argumentError(`ambiguous option: ${name} could match ${matching.join(', ')}`);
    }
    const option = matching[0];
    if (option === '--is-cli' || option === '--help') {
      if (equals !== -1) {
        argumentError(`argument ${option}: ignored explicit argument '${argument.slice(equals + 1)}'`);
      }
      if (option === '--help') {
        return parseArguments(['--help']);
      }
      args.is_cli = true;
      continue;
    }
    let value;
    if (equals !== -1) {
      value = argument.slice(equals + 1);
    } else {
      value = argv[index + 1];
      if (value === undefined || (value.startsWith('-') && !/^-\d+(?:\.\d*)?(?![\s\S])/.test(value))) {
        argumentError(`argument ${option}: expected one argument`);
      }
      index += 1;
    }
    if (option === '--repo') {
      args.repo = value;
    } else {
      if (!/^[+-]?\d+(?![\s\S])/.test(value) || !Number.isSafeInteger(Number(value))) {
        argumentError(`argument --release-id: invalid int value: '${value}'`);
      }
      args.release_id = Number(value);
    }
  }
  if (!positions.length) {
    argumentError('the following arguments are required: command');
  }
  if (!['plan', 'draft', 'post-publish'].includes(positions[0])) {
    argumentError(`argument command: invalid choice: '${positions[0]}' (choose from 'plan', 'draft', 'post-publish')`);
  }
  if (positions.length > 1) {
    argumentError(`unrecognized arguments: ${positions.slice(1).join(' ')}`);
  }
  args.command = positions[0];
  if (!args.repo || !/^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+(?![\s\S])/u.test(args.repo)) {
    argumentError('--repo owner/repo or GITHUB_REPOSITORY is required');
  }
  if (args.command === 'post-publish' && (args.release_id === null || args.release_id <= 0)) {
    argumentError('post-publish requires --release-id ID');
  }
  if (args.command !== 'post-publish' && args.release_id !== null) {
    argumentError('--release-id is only valid for post-publish');
  }
  return args;
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const head = git(['rev-parse', 'HEAD']);
  ensureMain(head);
  let result;
  if (args.command === 'post-publish') {
    result = postPublish(args.repo, args.release_id, head);
  } else {
    const items = releases(args.repo);
    const candidate = plan(args.repo, items, head);
    result = candidate;
    if (args.command === 'draft' && candidate.version) {
      result = prepareDraft(args.repo, items, managedDraft(items), candidate, head, args.is_cli);
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { classify, semver };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Release failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
