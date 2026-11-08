-- Native PostgreSQL bcrypt keeps expensive password work outside Worker CPU.
-- Existing credential values are deliberately not rewritten without a verified
-- password. The Node runtime upgrades them after a successful sign-in.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
