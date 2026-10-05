-- Teléfonos que activaron notificaciones push. endpoint es la dirección única que da el servicio de push
-- (Apple, Google, Mozilla); p256dh y auth son las claves públicas del teléfono para cifrar cada mensaje.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY NOT NULL CHECK(endpoint LIKE 'https://%' AND length(endpoint) <= 1000),
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL CHECK(length(p256dh) BETWEEN 1 AND 200),
  auth TEXT NOT NULL CHECK(length(auth) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(household_id, user_id) REFERENCES household_members(household_id, user_id) ON DELETE CASCADE
);

CREATE INDEX idx_push_subscriptions_household ON push_subscriptions(household_id, user_id);
