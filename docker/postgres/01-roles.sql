-- Runs once, when the data directory is created. The two roles of ADR 0003: the migrator owns the
-- schema and runs migrations; the service runs as wagering_app with no DDL and no DELETE. Per-table
-- privileges (no UPDATE on the ledger) are set by the migrations that create the tables.
-- Local passwords; .env.example carries the matching URLs.
CREATE ROLE wagering_migrator LOGIN PASSWORD 'wagering_migrator';
CREATE ROLE wagering_app LOGIN PASSWORD 'wagering_app';

-- Two databases, one pair of roles (`ops.suite-isolation`): `wagering` is what the Compose stack
-- runs on and what `make demo` writes to, `wagering_test` is what the suites migrate, truncate
-- between cases and reconcile. Separating them is what lets the demonstrations and `make check` run
-- on one set of containers without the suites emptying the tables the stack is serving from.
ALTER DATABASE wagering OWNER TO wagering_migrator;
CREATE DATABASE wagering_test OWNER wagering_migrator;

-- Schema access and default privileges are per database, so the same grants are applied inside
-- each. They are stated once, as a psql variable, so the two databases cannot drift apart: psql
-- keeps its variables across \connect, and expands :grants into the session it is then on.
\set grants 'GRANT USAGE ON SCHEMA public TO wagering_app; ALTER DEFAULT PRIVILEGES FOR ROLE wagering_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO wagering_app; ALTER DEFAULT PRIVILEGES FOR ROLE wagering_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO wagering_app;'

\connect wagering
:grants

\connect wagering_test
:grants
