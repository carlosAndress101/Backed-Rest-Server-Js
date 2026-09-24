// Temporary upload files, ported from e2e/helpers/db.js (T1.4, T1.7), and the media module's Cloudinary stub (T3.7).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import { CloudinaryClient } from '../../src/modules/media/cloudinary.client';

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

/**
 * Replaces the media module's injected Cloudinary client for the current test (undone by restoreMocks):
 * every upload resolves to `secureUrl` and every destroy succeeds, with no network and no disk (TEST-03).
 */
export const stubMediaClient = (secureUrl: string) => ({
  upload: vi.spyOn(CloudinaryClient.prototype, 'upload').mockResolvedValue({ secureUrl }),
  destroy: vi.spyOn(CloudinaryClient.prototype, 'destroy').mockResolvedValue(undefined),
});
