import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(`Arcane Android distribution build failed: ${message}`);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function run(command, args, cwd) {
  let executable = command;
  let executableArgs = args;
  let windowsVerbatimArguments = false;
  if (process.platform === 'win32' && path.extname(command).toLowerCase() === '.bat') {
    const commandName = path.basename(command);
    const commandValues = [commandName, ...args];
    for (const value of commandValues) {
      if (typeof value !== 'string' || value.length === 0 || /["\r\n&|<>^%!]/.test(value)) {
    fail('Gradle command contains an unsafe Microsoft NT command-shell value.');
      }
    }
    executable = process.env.ComSpec || 'cmd.exe';
    executableArgs = [
      '/d',
      '/s',
      '/c',
      `call ${commandName} ${args.map((value) => `"${value}"`).join(' ')}`,
    ];
    windowsVerbatimArguments = true;
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, executableArgs, {
      cwd,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${path.basename(command)} exited with ${code ?? signal ?? 'unknown status'}.`));
        return;
      }
      resolve();
    });
  });
}

async function packageFile(source, destination, descriptor) {
  const data = await fs.readFile(source);
  await fs.writeFile(destination, data, { flag: 'wx' });
  return Object.freeze({ ...descriptor, file: path.basename(destination), size: data.length, sha256: sha256(data) });
}

async function replaceDirectory(staging, target, parent) {
  if (!isInside(parent, staging) || !isInside(parent, target) || staging === parent || target === parent) {
    fail('publication path escapes dist.');
  }
  const backup = path.join(parent, `.android-backup-${process.pid}`);
  let moved = false;
  try {
    await fs.rename(target, backup);
    moved = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(staging, target);
    if (moved) await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (moved) await fs.rename(backup, target).catch(() => {});
    throw error;
  }
}

export async function buildAndroidDistribution({ bundleRoot } = {}) {
  if (typeof bundleRoot !== 'string' || bundleRoot.length === 0) fail('bundleRoot is required.');
  if (!process.env.JAVA_HOME) fail('JAVA_HOME must identify a Java 17 runtime.');
  if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) fail('ANDROID_HOME or ANDROID_SDK_ROOT must identify the Android SDK.');
  const root = path.resolve(bundleRoot);
  const android = path.join(root, 'android');
  const gradle = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const gradleArgs = [
    '--no-daemon',
    `-ParcaneNodeExecutable=${process.execPath}`,
    ':app:assembleDebug',
    ':apphost:assembleDebug',
  ];
  await run(gradle, gradleArgs, android);

  const appIndex = JSON.parse(await fs.readFile(path.join(root, 'dist', 'android-build-assets', 'app-index.json'), 'utf8'));
  if (appIndex?.schemaVersion !== 1 || !Array.isArray(appIndex.apps) || appIndex.apps.length === 0) {
    fail('generated application index is invalid.');
  }
  const dist = path.join(root, 'dist');
  const target = path.join(dist, 'android');
  const staging = await fs.mkdtemp(path.join(dist, '.android-stage-'));
  try {
    const packages = [];
    packages.push(await packageFile(
      path.join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
      path.join(staging, 'ArcaneLauncher-debug.apk'),
      { type: 'launcher', id: 'shell', packageName: 'os.arcane.host.android', version: appIndex.bundleVersion },
    ));
    for (const application of appIndex.apps) {
      const source = path.join(
        android,
        'apphost',
        'build',
        'outputs',
        'apk',
        application.flavor,
        'debug',
        `apphost-${application.flavor}-debug.apk`,
      );
      packages.push(await packageFile(
        source,
        path.join(staging, `ArcaneApp-${application.id}-debug.apk`),
        {
          type: 'application',
          id: application.id,
          packageName: application.packageName,
          displayName: application.displayName,
          version: appIndex.bundleVersion,
          networkAccess: application.networkAccess,
        },
      ));
    }
    const manifest = Object.freeze({
      schemaVersion: 1,
      bundleVersion: appIndex.bundleVersion,
      buildMode: 'debug-local-test',
      signingClaim: 'android-debug-key-no-publisher-trust',
      packages,
    });
    await fs.writeFile(path.join(staging, 'arcane-android-distribution.json'), canonicalJson(manifest), { flag: 'wx' });
    await replaceDirectory(staging, target, dist);
    console.log(`Published ${packages.length} debug-local-test Android APKs at ${path.relative(root, target)}.`);
    return Object.freeze({ target, manifest });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

const invokedAsCli = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsCli) {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    console.error('Usage: node tools/build-android-distribution.mjs');
    process.exitCode = 2;
  } else {
    const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    try {
      await buildAndroidDistribution({ bundleRoot });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
