-- Tablas de Better Auth (inicio de sesión con Google). Generadas con getMigrations de better-auth 1.7.6
-- y modelos renombrados con prefijo auth_. Las columnas conservan los nombres camelCase que espera Better Auth.
-- Los tokens OAuth se guardan cifrados (account.encryptOAuthTokens); no hay contraseñas.
CREATE TABLE "auth_users" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE "auth_sessions" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "auth_users" ("id") on delete cascade);

CREATE TABLE "auth_accounts" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "auth_users" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

CREATE TABLE "auth_verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions" ("userId");
CREATE INDEX "auth_accounts_userId_idx" ON "auth_accounts" ("userId");
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" ("identifier");
-- Una identidad de proveedor solo puede vincularse a una cuenta.
CREATE UNIQUE INDEX "auth_accounts_provider_account_idx" ON "auth_accounts" ("providerId", "accountId");
