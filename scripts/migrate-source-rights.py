#!/usr/bin/env python3
"""One-time v6 -> v7 source/rights migration. Backs up data before changing it."""
import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path


def migrate(db_path: Path) -> None:
    if not db_path.is_file():
        raise SystemExit(f"Database not found: {db_path}")
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        columns = {row[1] for row in db.execute("PRAGMA table_info(entries)")}
        required = {"sourceUrl", "sourceTitle", "sourceGame"}
        if not required <= columns or "source" in columns:
            raise SystemExit("Expected v6 entries schema; database was not modified")
        issues = db.execute("PRAGMA integrity_check").fetchone()[0]
        if issues != "ok":
            raise SystemExit(f"Preflight integrity check failed: {issues}")
        if db.execute("SELECT COUNT(*) FROM entries WHERE trim(sourceUrl) = ''").fetchone()[0]:
            raise SystemExit("Entries with empty sourceUrl found; database was not modified")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = db_path.with_name(f"atlas-before-source-rights-{stamp}.db")
        if backup.exists():
            raise SystemExit(f"Backup already exists: {backup}")
        with sqlite3.connect(backup) as copy:
            db.backup(copy)
        legacy = [dict(row) for row in db.execute(
            "SELECT id, sourceTitle, sourceGame FROM entries WHERE sourceTitle <> '' OR sourceGame <> ''"
        )]
        audit = backup.with_suffix(".legacy-source.json")
        audit.write_text(json.dumps(legacy, ensure_ascii=False, indent=2) + "\n")
        before = db.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("ALTER TABLE entries RENAME COLUMN sourceUrl TO source")
            db.execute("ALTER TABLE entries DROP COLUMN sourceTitle")
            db.execute("ALTER TABLE entries DROP COLUMN sourceGame")
            db.execute("ALTER TABLE entries ADD COLUMN author TEXT NOT NULL DEFAULT 'unclear'")
            db.execute("ALTER TABLE entries ADD COLUMN license TEXT NOT NULL DEFAULT 'unclear'")
            db.execute("ALTER TABLE entries ADD COLUMN trainable TEXT NOT NULL DEFAULT 'unclear' CHECK (trainable IN ('yes', 'no', 'unclear', 'user-yes'))")
            db.execute("UPDATE entries SET license = 'web-unverified' WHERE source LIKE 'http://%' OR source LIKE 'https://%'")
            after = db.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
            if before != after or db.execute("PRAGMA foreign_key_check").fetchall():
                raise RuntimeError("Post-migration entry count or foreign key check failed")
            db.commit()
        except Exception:
            db.rollback()
            raise
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Post-migration integrity check failed; restore the backup")
        print(f"Migrated {after} entries; backup: {backup}; legacy metadata: {audit}")
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    migrate(parser.parse_args().database)
