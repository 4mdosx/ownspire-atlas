"""One-time migration from grouped tags and Reference status to the current schema.

Usage: python3 scripts/migrate-tags-confidence-status.py /absolute/path/to/atlas.db
The script creates a SQLite-consistent backup next to the database before writing.
"""

import sqlite3
import sys
from pathlib import Path


def migrate(path: Path) -> None:
    if not path.is_file():
        raise SystemExit(f"Database not found: {path}")
    conn = sqlite3.connect(path)
    conn.execute('PRAGMA busy_timeout=5000')
    columns = lambda table: {row[1] for row in conn.execute(f'PRAGMA table_info({table})')}
    if 'groupName' not in columns('tags') or 'confidence' in columns('entry_tags'):
        raise SystemExit('Database is not at the expected pre-migration schema')
    statuses = dict(conn.execute('SELECT status, COUNT(*) FROM entries GROUP BY status'))
    if set(statuses) - {'inbox', 'reviewed', 'reference'}:
        raise SystemExit(f'Unknown status values: {statuses}')
    old_counts = {table: conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                  for table in ('entries', 'tags', 'entry_tags', 'entry_axis_values', 'monster_entries')}
    old_links = set(conn.execute('SELECT entryId, tagId, origin, ruleId, createdAt FROM entry_tags'))

    backup_path = path.with_name(f'{path.stem}-before-tags-confidence-status{path.suffix}')
    if backup_path.exists():
        raise SystemExit(f'Backup already exists; move or rename it first: {backup_path}')
    backup = sqlite3.connect(backup_path)
    try:
        conn.backup(backup)
    finally:
        backup.close()

    conn.execute('PRAGMA foreign_keys=OFF')
    with conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute("""CREATE TABLE entries_new (
          id TEXT PRIMARY KEY, domain TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
          sourceUrl TEXT NOT NULL, sourceTitle TEXT NOT NULL DEFAULT '', sourceGame TEXT NOT NULL DEFAULT '',
          imagePath TEXT NOT NULL DEFAULT '', imageSource TEXT NOT NULL DEFAULT 'file',
          originalName TEXT NOT NULL DEFAULT '', observed TEXT NOT NULL DEFAULT '',
          read TEXT NOT NULL DEFAULT '', worthwhileBecause TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending_ai' CHECK(status IN ('pending_ai', 'inbox', 'reviewed')),
          analysisStatus TEXT NOT NULL DEFAULT 'committed', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        )""")
        columns_sql = 'id,domain,name,sourceUrl,sourceTitle,sourceGame,imagePath,imageSource,originalName,observed,read,worthwhileBecause,status,analysisStatus,createdAt,updatedAt'
        conn.execute(f"INSERT INTO entries_new ({columns_sql}) SELECT id,domain,name,sourceUrl,sourceTitle,sourceGame,imagePath,imageSource,originalName,observed,read,worthwhileBecause,CASE WHEN status='reference' THEN 'reviewed' ELSE status END,analysisStatus,createdAt,updatedAt FROM entries")
        conn.execute('DROP TABLE entries')
        conn.execute('ALTER TABLE entries_new RENAME TO entries')
        conn.execute('CREATE INDEX entries_status_idx ON entries(status, createdAt)')
        conn.execute('CREATE INDEX entries_created_idx ON entries(createdAt)')
        conn.execute('CREATE INDEX entries_domain_idx ON entries(domain, createdAt)')
        conn.execute('ALTER TABLE tags DROP COLUMN groupName')
        conn.execute('ALTER TABLE entry_tags ADD COLUMN confidence REAL NOT NULL DEFAULT 1 CHECK(confidence BETWEEN 0 AND 1)')
        assert old_counts == {table: conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] for table in old_counts}
        assert old_links == set(conn.execute('SELECT entryId, tagId, origin, ruleId, createdAt FROM entry_tags'))
        assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    conn.close()
    print(f'Migrated {path}; backup: {backup_path}; preserved: {old_counts}; old statuses: {statuses}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 scripts/migrate-tags-confidence-status.py /absolute/path/to/atlas.db')
    migrate(Path(sys.argv[1]).resolve())
