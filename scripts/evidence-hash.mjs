import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

export function sha256RegularFile(filePath) {
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return null;
  }

  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}
