-- Color visual editable, separado de slot. slot sigue siendo la posición permanente
-- (blue = quien creó el hogar, pink = quien se unió) que decide el centavo impar en los repartos.
ALTER TABLE household_members ADD COLUMN color TEXT NOT NULL DEFAULT 'blue'
  CHECK(color IN ('blue','pink','green','purple','orange','teal'));
UPDATE household_members SET color = slot;
-- Colores distintos dentro del hogar para distinguir visualmente quién gastó qué.
CREATE UNIQUE INDEX idx_household_members_color ON household_members(household_id, color);

-- Invitaciones de un solo uso para que la pareja se una. Solo se guarda el hash del código.
CREATE TABLE household_invites (
  code_hash TEXT PRIMARY KEY NOT NULL CHECK(length(code_hash) = 64),
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(household_id, created_by) REFERENCES household_members(household_id, user_id),
  CHECK((used_by IS NULL) = (used_at IS NULL))
);
CREATE INDEX idx_household_invites_household ON household_invites(household_id);
