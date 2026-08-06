-- Let a report point at the conversation it is about, and preserve that
-- conversation as evidence.
--
-- Nullable: reports raised from a profile card have no conversation.
ALTER TABLE reports
  ADD COLUMN match_id uuid REFERENCES matches(id) ON DELETE SET NULL;

CREATE INDEX reports_match_idx ON reports (match_id) WHERE match_id IS NOT NULL;

-- Evidence snapshot.
--
-- Messages in this product disappear: per-conversation TTL deletes them, and
-- a blocked or deleted account takes its matches with it. A moderator opening
-- a report hours later would find nothing. So the messages visible at the
-- moment of reporting are copied here, once, and survive independently.
--
-- The privacy trade-off is deliberate and bounded:
--   - only the reported conversation, only what already existed at report time
--   - captured only when a user chooses to report, which is itself the act of
--     handing that conversation to moderation
--   - purged 90 days after the report is resolved (see the sweeper)
--   - reading it is reason-gated and written to sensitive_access_log
--
-- Denormalised on purpose: it must outlive the messages, profiles and
-- accounts it came from, so it stores names rather than foreign keys.
CREATE TABLE report_evidence (
  id            bigserial PRIMARY KEY,
  report_id     uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  sender_name   text NOT NULL,
  sender_is_subject boolean NOT NULL,
  body          text NOT NULL,
  sent_at       timestamptz NOT NULL,
  captured_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX report_evidence_report_idx ON report_evidence (report_id, sent_at);

-- Drives the purge of evidence for long-settled reports.
CREATE INDEX reports_resolved_idx ON reports (resolved_at) WHERE resolved_at IS NOT NULL;
