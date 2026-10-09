#!/usr/bin/env python3
"""One-time migration for the six-axis layout and narrowed license options."""
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
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("Database integrity check failed before migration")
        old = [dict(row) for row in db.execute("SELECT id, license, trainable FROM entries WHERE license IN ('web-unverified', 'mit', 'apache-2.0')")]
        axes = {row["key"]: dict(row) for row in db.execute("SELECT key, labelZh, labelEn, groupKey FROM design_axes WHERE spaceId = 'space-mine'")}
        if not {'visualComplexity', 'familiarity'} <= axes.keys():
            raise SystemExit("Expected six-axis schema; database was not modified")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = db_path.with_name(f"atlas-before-axis-license-{stamp}.db")
        with sqlite3.connect(backup) as copy:
            db.backup(copy)
        audit = backup.with_suffix(".old-options.json")
        audit.write_text(json.dumps({"licenses": old, "axes": axes}, ensure_ascii=False, indent=2) + "\n")
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute("UPDATE entries SET license='unclear', trainable=CASE WHEN trainable='user-yes' THEN trainable ELSE 'unclear' END WHERE license IN ('web-unverified', 'mit', 'apache-2.0')")
            db.execute("UPDATE design_axes SET labelZh='符号化', labelEn='Symbolization', hintZh='造型有多接近可识别的现实符号 —— 从抽象到写实', groupKey='可读性|Readability', sortOrder=40 WHERE spaceId='space-mine' AND key='familiarity'")
            db.execute("UPDATE design_axes SET labelZh='直觉复杂度', labelEn='Intuitive Complexity', hintZh='第一眼需要处理多少视觉信息 —— 从清晰剪影到繁复细节', groupKey='可读性|Readability', sortOrder=50 WHERE spaceId='space-mine' AND key='visualComplexity'")
            db.execute("UPDATE design_axes SET hintZh='画面上占多满 —— 注意是视觉重量，不是实际体积' WHERE spaceId='space-mine' AND key='visualMass'")
            db.execute("UPDATE design_axes SET sortOrder=60 WHERE spaceId='space-mine' AND key='threatAffinity'")
            if db.execute("PRAGMA foreign_key_check").fetchall():
                raise RuntimeError("Foreign key check failed")
            db.commit()
        except Exception:
            db.rollback()
            raise
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError(f"Post-migration integrity check failed; restore {backup}")
        print(f"Migrated {len(old)} license records and axis labels; backup: {backup}; audit: {audit}")
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    migrate(parser.parse_args().database)
