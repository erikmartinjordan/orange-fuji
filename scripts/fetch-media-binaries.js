#!/usr/bin/env node
/**
 * Fetches macOS ffmpeg binaries for BOTH CPU architectures into src/bin/.
 *
 * Why: `ffmpeg-static` installs a single binary for the *build machine's*
 * architecture. The legacy macOS DMG targets Intel (x64) but is built on
 * arm64 CI runners, so packaged builds used to ship an arm64-only ffmpeg
 * that dies with "Bad CPU type" on Intel Macs — silently degrading MP4
 * exports to .webm fallbacks.
 *
 * This script downloads ffmpeg-darwin-{arm64,x64} from the same release tag
 * as the installed ffmpeg-static dependency, so runtime resolution
 * (src/pro/media-binaries.js) can pick the right one via process.arch.
 *
 * Behavior:
 *   - Skips files that already exist (idempotent).
 *   - Exits 0 without downloading on non-macOS hosts (mac artifacts are only
 *     produced on macOS runners).
 *   - Network failures are warnings, not hard errors, so local/offline builds
 *     still work when node_modules/ffmpeg-static matches the host arch.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const DEST_DIR = path.join(__dirname, '..', 'src', 'bin');
const ARCHES = ['arm64', 'x64'];

function readReleaseTag() {
  try {
    const pkg = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'package.json'),
      'utf8',
    ));
    return pkg['ffmpeg-static']?.['binary-release-tag'] || null;
  } catch (_) {
    return null;
  }
}

function getRedirected(url) {
  return new Promise((resolve, reject) => {
    const request = (target, redirectsLeft) => {
      https.get(target, { headers: { 'user-agent': 'orange-fuji-build' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${target}`));
            return;
          }
          request(new URL(response.headers.location, target).href, redirectsLeft - 1);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode} for ${target}`));
          return;
        }
        resolve(response);
      }).on('error', reject);
    };
    request(url, 5);
  });
}

async function downloadAndGunzip(url, destination) {
  const response = await getRedirected(url);
  const tempPath = `${destination}.download`;
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tempPath, { mode: 0o755 });
    const gunzipped = zlib.createGunzip();
    const fail = (error) => {
      file.destroy();
      reject(error);
    };
    response.on('error', fail);
    gunzipped.on('error', fail);
    file.on('error', fail);
    file.on('finish', () => {
      try {
        fs.renameSync(tempPath, destination);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    response.pipe(gunzipped).pipe(file);
  });
}

function looksLikeMachO(filePath) {
  try {
    const header = fs.readFileSync(filePath).subarray(0, 4);
    // MH_MAGIC_64 / MH_CIGAM_64 or FAT_MAGIC (universal).
    return header.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
      || header.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xce]))
      || header.equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
  } catch (_) {
    return false;
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log(`fetch-media-binaries: skipping on ${process.platform} (macOS binaries are only bundled by mac builds)`);
    return;
  }

  const releaseTag = readReleaseTag() || process.env.FFMPEG_BINARY_RELEASE;
  if (!releaseTag) {
    console.warn('fetch-media-binaries: could not determine ffmpeg-static release tag; skipping.');
    return;
  }
  const baseUrl = `https://github.com/eugeneware/ffmpeg-static/releases/download/${releaseTag}`;

  fs.mkdirSync(DEST_DIR, { recursive: true });
  let downloaded = 0;

  for (const arch of ARCHES) {
    const destination = path.join(DEST_DIR, `ffmpeg-${arch}`);
    if (fs.existsSync(destination)) {
      console.log(`fetch-media-binaries: ${destination} already present`);
      continue;
    }
    const url = `${baseUrl}/ffmpeg-darwin-${arch}.gz`;
    try {
      process.stdout.write(`fetch-media-binaries: downloading ${url} ... `);
      await downloadAndGunzip(url, destination);
      if (!looksLikeMachO(destination)) throw new Error('downloaded file is not a Mach-O binary');
      fs.chmodSync(destination, 0o755);
      console.log('done');
      downloaded += 1;
    } catch (error) {
      console.warn(`failed (${error.message})`);
      try { fs.rmSync(`${destination}.download`, { force: true }); } catch (_) { /* ignore */ }
      try { fs.rmSync(destination, { force: true }); } catch (_) { /* ignore */ }
    }
  }

  if (downloaded > 0) {
    console.log(`fetch-media-binaries: fetched ${downloaded} ffmpeg build(s) (${releaseTag})`);
  }
}

main().catch((error) => {
  console.warn(`fetch-media-binaries: unexpected failure ignored: ${error.message}`);
});
