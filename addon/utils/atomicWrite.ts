// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import fs from 'fs';
import path from 'path';

function buildTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}

function isTransientRenameError(err: any): boolean {
  const code = err?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf8'
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = buildTempPath(filePath);
  try {
    if (Buffer.isBuffer(data)) {
      await fs.promises.writeFile(tempPath, data);
    } else {
      await fs.promises.writeFile(tempPath, data, encoding);
    }

    try {
      await fs.promises.rename(tempPath, filePath);
    } catch (renameErr: any) {
      if (!isTransientRenameError(renameErr)) throw renameErr;
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        await fs.promises.rename(tempPath, filePath);
      } catch (retryErr: any) {
        if (process.platform === 'win32' && isTransientRenameError(retryErr)) {
          await fs.promises.copyFile(tempPath, filePath);
          await fs.promises.unlink(tempPath).catch(() => {});
          return;
        }
        throw retryErr;
      }
    }
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => {});
    throw err;
  }
}

export function writeFileAtomicSync(
  filePath: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf8'
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = buildTempPath(filePath);
  try {
    if (Buffer.isBuffer(data)) {
      fs.writeFileSync(tempPath, data);
    } else {
      fs.writeFileSync(tempPath, data, encoding);
    }

    try {
      fs.renameSync(tempPath, filePath);
    } catch (renameErr: any) {
      if (!isTransientRenameError(renameErr)) throw renameErr;
      try {
        fs.renameSync(tempPath, filePath);
      } catch (retryErr: any) {
        if (process.platform === 'win32' && isTransientRenameError(retryErr)) {
          fs.copyFileSync(tempPath, filePath);
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // Ignore cleanup failure after copy fallback
          }
          return;
        }
        throw retryErr;
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore missing or already-removed temp file
    }
    throw err;
  }
}
