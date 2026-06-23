import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const bumpType = process.argv[2] ?? 'patch';
const allowedBumpTypes = new Set(['patch', 'minor', 'major']);

if (!allowedBumpTypes.has(bumpType)) {
  throw new Error(`Unsupported bump type "${bumpType}". Use patch, minor, or major.`);
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Version "${version}" is not valid semantic versioning.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function bumpVersion(version) {
  const parsed = parseVersion(version);

  if (bumpType === 'major') {
    return `${parsed.major + 1}.0.0`;
  }

  if (bumpType === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const packagePath = path.join(rootDir, 'package.json');
const packageLockPath = path.join(rootDir, 'package-lock.json');
const versionPath = path.join(rootDir, 'config', 'version.ts');

const packageJson = await readJson(packagePath);
const nextVersion = bumpVersion(packageJson.version);

packageJson.version = nextVersion;
await writeJson(packagePath, packageJson);

const packageLock = await readJson(packageLockPath);
packageLock.version = nextVersion;
if (packageLock.packages?.['']) {
  packageLock.packages[''].version = nextVersion;
}
await writeJson(packageLockPath, packageLock);

await writeFile(versionPath, `export const APP_VERSION = '${nextVersion}';\n`);

console.log(nextVersion);
