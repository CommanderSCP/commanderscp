-- OUTPOST-RUN PROBES — evidence a PEER produced, reported upward (team-pipeline-iac D11/D23).
--
-- `pipeline_evidence.source` gains `peer_reported`. The three existing values all describe something
-- THIS instance did: it analysed a rollout, it was pushed to, its own executor was observed. A probe
-- runs in the DOMAIN — the commander does not reach in, and the digest-pinned test bundle lives in
-- the outpost's own Gitea — so its result arrives over the signed journal and needs a fourth answer
-- to "who produced this".
--
-- STAMPED BY THE RECEIVER, NEVER CARRIED ON THE WIRE. The journal entry deliberately ships no
-- `source`: a signed bundle proves WHO SENT it, not that its contents are true, so the importer
-- records what it knows rather than what the sender claimed about its own authority. That is the
-- same rule `recordTestRunEvidence` already states for the pushed door — provenance is the
-- authorization boundary, not the payload shape.
--
-- Widened by DROP + re-ADD because Postgres has no ALTER CONSTRAINT for a CHECK expression. No data
-- migration: every existing row holds one of the original three values, all still permitted.
ALTER TABLE pipeline_evidence DROP CONSTRAINT IF EXISTS "pipeline_evidence_source_check";
--> statement-breakpoint
ALTER TABLE pipeline_evidence ADD CONSTRAINT "pipeline_evidence_source_check"
  CHECK ("source" IN ('rollout_analysis', 'pushed', 'executor_observed', 'peer_reported'));
--> statement-breakpoint

COMMENT ON COLUMN pipeline_evidence.source IS
  'WHO produced this evidence: rollout_analysis | pushed | executor_observed | peer_reported. `peer_reported` is stamped by the RECEIVER at federation import (outpost-run probes) and is never read from the entry payload — a signed journal proves the sender, not the truth of its contents.';
