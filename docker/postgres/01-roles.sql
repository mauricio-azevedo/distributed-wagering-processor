-- Runs once, when the data directory is created. The two roles of ADR 0003: the migrator owns the
-- schema and runs migrations; the service runs as wagering_app with no DDL and no DELETE. Per-table
-- privileges (no UPDATE on the ledger) are set by the migrations that create the tables.
-- Local passwords; .env.example carries the matching URLs.
CREATE ROLE wagering_migrator LOGIN PASSWORD 'wagering_migrator';
CREATE ROLE wagering_app LOGIN PASSWORD 'wagering_app';

ALTER DATABASE wagering OWNER TO wagering_migrator;

GRANT USAGE ON SCHEMA public TO wagering_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wagering_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO wagering_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wagering_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wagering_app;
