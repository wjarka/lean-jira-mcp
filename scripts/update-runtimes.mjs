import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const stableVersion = /^\d+\.\d+\.\d+$/;

function requireVersion(version) {
  if (typeof version !== 'string' || !stableVersion.test(version)) {
    throw new Error(`Invalid stable runtime version: ${JSON.stringify(version)}`);
  }
  return version;
}

export function compareVersions(left, right) {
  const a = requireVersion(left).split('.').map(Number);
  const b = requireVersion(right).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function latestNodeLts(releases) {
  const versions = releases
    .filter((release) => typeof release.lts === 'string' && release.lts.length > 0)
    .map((release) => release.version?.replace(/^v/, ''))
    .filter((version) => typeof version === 'string' && stableVersion.test(version))
    .sort(compareVersions);
  if (!versions.length) throw new Error('Node release index contains no stable LTS release');
  return versions.at(-1);
}

export function latestBunStable(release) {
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error('Bun release is a draft or prerelease');
  }
  return requireVersion(release.tag_name?.replace(/^bun-v/, ''));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'lean-jira-mcp-runtime-updates' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

export async function updateRuntimes() {
  const [nodeReleases, bunRelease] = await Promise.all([
    fetchJson('https://nodejs.org/dist/index.json'),
    fetchJson('https://api.github.com/repos/oven-sh/bun/releases/latest'),
  ]);
  const updates = [
    ['.node-version', latestNodeLts(nodeReleases)],
    ['.bun-version', latestBunStable(bunRelease)],
  ];
  // Validate all input before changing either pin. Never downgrade tooling.
  const current = await Promise.all(updates.map(([file]) => readFile(file, 'utf8')));
  const comparisons = updates.map(([, next], i) => compareVersions(next, current[i].trim()));
  for (const [i, [file, next]] of updates.entries()) {
    if (comparisons[i] > 0) {
      await writeFile(file, `${next}\n`);
      console.log(`${file}: ${current[i].trim()} -> ${next}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await updateRuntimes();
}
