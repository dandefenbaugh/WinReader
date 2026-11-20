import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stage = await mkdtemp(join(tmpdir(), 'winreader-package-'));

try {
  const assets = ['ms_sans_serif.woff2', 'ms_sans_serif_bold.woff2', 'font-credits.txt', 'refresh.png', 'feeds.png',
    'article.png', 'hourglass.png', 'up.png', 'down.png', 'xp-refresh.png', 'xp-feeds.png', 'xp-article.png'];
  const files = ['main.cjs', 'preload.cjs', 'index.html', 'style.css', 'xp.css', 'dos.css', 'subscriptions.opml', 'dist/reader.js',
    ...assets.map(file => join('assets', file))];
  for (const file of files) {
    const destination = join(stage, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, file), destination);
  }
  await writeFile(join(stage, 'package.json'), JSON.stringify({
    name: metadata.name,
    productName: 'WinReader',
    version: metadata.version,
    main: metadata.main
  }));

  const bundles = await packager({
    dir: stage,
    name: 'WinReader',
    platform: 'darwin',
    arch: process.env.WINREADER_MAC_ARCH || process.arch,
    electronVersion: metadata.devDependencies.electron,
    electronZipDir: process.env.WINREADER_ELECTRON_ZIP_DIR,
    appBundleId: 'com.winreader.desktop',
    icon: join(root, 'assets/WinReader'),
    out: join(root, 'release'),
    asar: true,
    overwrite: true,
    prune: false
  });
  for (const bundle of bundles) {
    const app = join(bundle, 'WinReader.app');
    await copyFile(join(root, 'LICENSE'), join(app, 'Contents', 'Resources', 'WinReader-LICENSE.txt'));
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(app);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
