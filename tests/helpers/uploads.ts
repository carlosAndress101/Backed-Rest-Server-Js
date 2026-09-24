// Temporary upload files and upload dirs, ported from e2e/helpers/db.js (T1.4, T1.7) with the same behaviour.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [...new Set(['/tmp', os.tmpdir()].map((dir) => path.normalize(dir)))];

/**
 * Temp names are `tmp-<counter>-<pid><timestamp>` (express-fileupload). Filter
 * by our own pid so files written by parallel test processes are ignored.
 *
 * C10: each upload request writes its temp files into its own
 * `upload-<pid>-<uuid>` folder, so a folder left behind is a leak too.
 */
const isOwnTempEntry = (name: string) =>
  (name.startsWith('tmp-') && name.includes(`-${process.pid}`)) || name.startsWith(`upload-${process.pid}-`);

export const listTempFiles = () => {
  const found = new Set<string>();
  TMP_DIRS.forEach((dir) => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      entries = [];
    }
    entries.filter(isOwnTempEntry).forEach((name) => found.add(path.join(dir, name)));
  });
  return found;
};

export const newTempFiles = (before: Set<string>) => {
  const after = listTempFiles();
  return [...after].filter((file) => !before.has(file));
};

/** Polls briefly so an awaited-but-async cleanup is not a race. */
export const waitForNoTempLeak = async (before: Set<string>, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  let leaked = newTempFiles(before);
  while (leaked.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    leaked = newTempFiles(before);
  }
  return leaked;
};

export const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

export const resetUploadDirs = () => {
  ['imgs', 'user', 'product'].forEach((folder) => {
    const dir = path.join(UPLOAD_DIR, folder);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
