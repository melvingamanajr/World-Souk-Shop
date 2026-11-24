import { chmod, link, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

async function createSnapshot(sourcePath, destinationPath) {
  const destination = resolve(destinationPath);
  const directory = await mkdtemp(join(dirname(destination), '.wss-backup-'));
  const snapshot = join(directory, 'snapshot.sqlite');
  try {
    const source = new DatabaseSync(resolve(sourcePath), { readOnly: true, timeout: 5000 });
    try {
      await backup(source, snapshot);
    } finally {
      source.close();
    }

    const copied = new DatabaseSync(snapshot);
    try {
      copied.exec('PRAGMA journal_mode = DELETE');
      const integrity = copied.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || copied.prepare('PRAGMA foreign_key_check').get()) {
        throw new Error('The snapshot failed database integrity validation.');
      }
    } finally {
      copied.close();
    }

    await chmod(snapshot, 0o600);
    // Create the destination atomically. A concurrent run cannot overwrite an existing snapshot.
    await link(snapshot, destination);
    return destination;
  } finally {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      await rm(snapshot + suffix, { force: true });
    }
    await rmdir(directory);
  }
}

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length > 0) {
  console.error('Usage: node scripts/backup.mjs <source.sqlite> <new-destination.sqlite>');
  process.exitCode = 2;
} else {
  try {
    const saved = await createSnapshot(source, destination);
    console.log('Verified SQLite snapshot saved to %s', saved);
  } catch (error) {
    const message = error.code === 'EEXIST' ? 'Choose a destination filename that does not exist.' : error.message;
    console.error('Backup failed. %s', message);
    process.exitCode = 1;
  }
}
