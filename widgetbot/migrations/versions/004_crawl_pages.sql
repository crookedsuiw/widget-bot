-- Phase 2, slice 2: per-page crawl results for the Overview's "Website knowledge" card.

-- [{"url", "strategy", "ok", "chunks", "error"}], filled page by page while the crawl runs
ALTER TABLE crawl_runs ADD COLUMN pages JSONB NOT NULL DEFAULT '[]';

-- At most one running crawl per client (a second "Re-crawl" click is refused, not queued)
CREATE UNIQUE INDEX crawl_runs_one_running ON crawl_runs (client_id) WHERE status = 'running';
