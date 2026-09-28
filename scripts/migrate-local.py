"""Aplicador local; no conecta ni modifica Turso remoto."""
import hashlib
import pathlib
import sqlite3

ROOT = pathlib.Path(__file__).resolve().parents[1]

def migrate(connection):
    connection.execute('PRAGMA foreign_keys=ON')
    connection.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
    connection.commit()
    for path in sorted((ROOT / 'database' / 'migrations').glob('*.sql')):
        sql = path.read_text()
        checksum = hashlib.sha256(sql.encode()).hexdigest()
        previous = connection.execute('SELECT sha256 FROM schema_migrations WHERE name=?', (path.name,)).fetchone()
        if previous:
            if previous[0] != checksum:
                raise RuntimeError(f'Migración ya aplicada modificada: {path.name}')
            continue
        try:
            connection.executescript('BEGIN IMMEDIATE;\n' + sql)
            connection.execute('INSERT INTO schema_migrations(name, sha256) VALUES (?, ?)', (path.name, checksum))
            connection.commit()
        except Exception:
            connection.rollback()
            raise

if __name__ == '__main__':
    folder = ROOT / '.data'
    folder.mkdir(exist_ok=True)
    with sqlite3.connect(folder / 'juntos.db') as db:
        migrate(db)
    print('Esquema local aplicado: .data/juntos.db (sin conexión a Turso).')
