---
title: "LoomBrain API: remove episodic_memory tenant feature flag"
type: Chore
issue: 7
research: ["research/research-session-capture-ctrl-c-exit.md"]
status: Ready for Implementation
reviewed: true
reviewers: ["codex"]
reviewers_skipped: ["gemini (API capacity exhausted 2026-04-11)"]
created: 2026-04-11
last_updated: 2026-04-11
---

# PRD: Remove `episodic_memory` tenant feature flag — make episodic capture a core, always-on feature

> **Note to the backend engineer receiving this plan**: This plan is written from the plugin side (where the flag manifests as a 403 error). File paths and specific code locations in the LoomBrain API backend are placeholders marked `<TODO: backend path>` — you will need to locate them in the backend repository before starting. Everything else (goals, acceptance criteria, rollout, rollback) is specified.

## Metadata
- **Type**: Chore (product decision implemented as code cleanup)
- **Priority**: High
- **Severity**: Major — current behavior silently blocks core plugin functionality for any tenant without the flag
- **Estimated Complexity**: 4
- **Created**: 2026-04-11
- **Status**: Draft

## Overview

### Problem Statement

Episodic memory capture is gated behind a tenant-level feature flag (`memory:episodic_enabled` or similar — backend-side name to confirm). When a tenant lacks the flag, `POST /api/v1/captures` with `content_type: "session"` returns `403` with a body containing the string `episodic_memory` (the plugin matches on this in `loombrain-sessions/src/api-client.ts:146-147`).

Evidence from the `loombrain-sessions` plugin's capture log:

```
[2026-04-10T16:22:13.703Z] ERROR: Episodic memory not enabled for this tenant
[2026-04-10T16:35:56.510Z] ERROR: Episodic memory not enabled for this tenant
[2026-04-11T19:39:19.512Z] ERROR: Episodic memory not enabled for this tenant
```

Product decision (user, 2026-04-11): **"Episodic memory should be turned on for everybody all the time, there should be no switch. It's a core feature."**

The flag must be removed so that every authenticated tenant can create episodic captures unconditionally. Any code path that checks the flag should be removed, any database column/record storing it should be migrated, and any tenant provisioning logic should stop setting/clearing it.

### Goals & Objectives

1. **Remove the runtime check**: `POST /api/v1/captures` with `content_type: "session"` (and `episode_events` payloads) succeeds for every authenticated tenant regardless of flag state.
2. **Remove the storage**: Drop or mark-deprecated any column, config row, or KV entry holding the `episodic_memory` flag.
3. **Remove the admin controls**: If there is a tenant admin UI or CLI switch for this flag, remove it.
4. **Preserve audit trail**: Log the one-time migration so future engineers know when the flag was retired.
5. **Do not break existing episodic data**: Tenants who currently have the flag enabled continue to function identically; tenants who did not have it now also work.

### Success Metrics

- **Primary Metric**: Zero `403` responses with body containing `episodic_memory` in production logs for the 7 days after deploy.
- **Secondary Metrics**:
  - Total `POST /api/v1/captures` error rate (4xx/5xx) for previously-gated tenants remains within ±1% of the baseline for tenants that always had the flag — catches "error mode replaced with different failure" regression. <!-- Addressed [Codex Medium]: success metric masking -->
  - Endpoint-level success rate (2xx) ≥ 99% for the captures route in the first 7 days post-deploy.
  - All existing plugin users (all tenants) see `Capture complete: N/N chunk(s) uploaded` in `~/.loombrain-sessions/capture.log` (correlated via customer support).
  - `bun test` / `pytest` / `<backend test runner>` passes with the feature flag checks removed.
- **Quality Gates**:
  - Integration test: POST a session capture from a tenant that previously did not have the flag → 201 response.
  - Integration test: auth failure, invalid payload, and rate-limit paths on `/api/v1/captures` continue to return their expected 4xx codes — unchanged by this chore. <!-- Addressed [Codex High]: unchanged error paths regression coverage -->
  - Migration dry-run report: list of tenants affected (any tenant whose flag was OFF), captured and logged BEFORE the drop executes. <!-- Addressed [Codex Medium]: audit count ambiguity -->

## User Stories

### Story 1: New tenant onboarding

- **As a**: New LoomBrain user signing up
- **I want**: To have episodic memory capture available immediately without any admin intervention
- **So that**: My Claude Code sessions start being captured the moment I install the plugin
- **Acceptance Criteria**:
  - [ ] A brand-new tenant with default settings can successfully POST a session capture
  - [ ] No additional UI toggle or config step is required

### Story 2: Existing tenant without flag

- **As a**: Existing LoomBrain user who never had `memory:episodic_enabled` set
- **I want**: My captures to start succeeding after the backend deploys this change
- **So that**: I don't have to contact support or wait for a flag flip
- **Acceptance Criteria**:
  - [ ] My existing plugin installation (any version) starts receiving `201` responses for captures after deploy
  - [ ] No data loss from previously-failed captures — the plugin's catchup mechanism (plugin plan) will re-upload recent orphans

## Requirements

### Functional Requirements

1. **FR-1: Remove runtime flag check** — The captures endpoint handler no longer evaluates the `episodic_memory` flag. Any `if (tenant.has_flag("episodic_memory"))` (or equivalent) is deleted along with its `else` branch that returned 403.
   - Details: `<TODO: backend path to captures route handler>`
   - Priority: Must Have

2. **FR-2: Remove flag from provisioning** — New tenants are no longer defaulted to having the flag OFF or ON; the flag ceases to exist.
   - Details: Tenant creation code, migrations, seeders, admin scripts
   - Priority: Must Have

3. **FR-3: Data migration** — Any database column/row holding the flag is dropped or deprecated.
   - Details: Migration file `<YYYYMMDDHHMM>_drop_episodic_memory_flag.sql` (or equivalent framework migration). Include `up` that drops the column and `down` that recreates it defaulting to TRUE.
   - Priority: Must Have

4. **FR-4: Remove admin controls** — Any admin dashboard, CLI command, or API endpoint that sets/reads this flag is removed. Any internal tooling or automation that consumed these controls is identified and updated.
   - Details: `<TODO: locate admin surfaces>`. Backend engineer must enumerate consumers of the admin API/CLI before removal (e.g., customer support runbooks, ops dashboards, billing reconciliation jobs).
   - Priority: Must Have (aligned with In Scope and Acceptance Criteria) <!-- Addressed [Codex Medium]: priority conflict -->

5. **FR-5: Audit log entry with pre-drop count** — Before dropping storage, compute the count of tenants who have/had the flag in each state (OFF/ON/NULL) and record it in a log line. Emit a second log at the end of the migration confirming the drop.
   - Details: The count MUST be computed BEFORE the column drop. Persist it in migration output, then the drop executes. This is deterministic and independent of application startup timing. <!-- Addressed [Codex Medium]: audit count ambiguity -->
   - Priority: Must Have

6. **FR-6: Update API documentation** — API docs no longer mention `episodic_memory` as a prerequisite for session captures.
   - Details: OpenAPI spec, README, internal docs.
   - Priority: Should Have

### Non-Functional Requirements

1. **NFR-1: Zero-downtime deploy**
   - Requirement: The change rolls out without dropping requests mid-migration.
   - Target: Deploy in two commits: (1) remove runtime check (read path ignores flag), (2) drop storage. Both are individually safe.
   - Measurement: No 5xx spike during deploy.

2. **NFR-2: Backwards compatibility with old API keys**
   - Requirement: Existing API keys / tokens continue to work without re-issuance.
   - Target: No changes to auth middleware.
   - Measurement: Existing plugin installs work immediately after deploy.

3. **NFR-3: Test coverage**
   - Requirement: Captures route integration tests cover both "old tenant with flag" and "old tenant without flag" cases pre-migration; post-migration both cases return 201.
   - Target: 100% of new code paths tested; migration has up+down test.
   - Measurement: Test runner green; coverage report updated.

### Technical Requirements

- **Stack**: `<TODO: backend stack — presumably TypeScript on Cloudflare Workers or similar given the plugin conventions>`
- **Dependencies**: None new
- **Architecture**: Modify captures route handler; run DB migration; remove admin code
- **Data Model**: Drop one column/field — OR mark as deprecated no-op and keep for one release cycle
- **API Contracts**: `POST /api/v1/captures` — behavior change: `403 episodic_memory not enabled` responses no longer occur

## Scope

### In Scope

- Removing the flag check in the captures route handler
- Removing tenant provisioning/seeding code that touches this flag
- DB migration to drop/deprecate the flag column
- Removing admin UI/CLI controls for the flag
- Updating API documentation
- Integration tests for captures route covering the "previously gated" path

### Out of Scope

- Redesigning the captures endpoint or payload schema
- Rate limiting changes (should stay the same)
- Pricing/billing changes (episodic memory now free for all tenants — business confirms this is intentional)
- Migrating existing episodic data (no data loss risk; episodic data for flagged-OFF tenants was simply never created)
- Plugin-side changes — covered in `plans/plugin-session-capture-resilience.md`

### Future Considerations

- Other similar feature flags that could be retired as "always on" core features
- Generalized feature-flag audit: which flags are still load-bearing?

## Impact Analysis

### Affected Areas

- `<TODO: captures route handler path>`
- `<TODO: tenant provisioning code path>`
- `<TODO: migrations directory>`
- `<TODO: admin/CLI surface for tenant flags>`
- API documentation (OpenAPI spec, README)
- Integration test suite for captures endpoint

### Users Affected

- **All LoomBrain tenants** — those without the flag gain access to episodic capture; those with the flag see no change
- **All loombrain-sessions plugin users** — their captures start succeeding after deploy

### System Impact

- **Performance**: Removing a flag check is strictly a perf win (one less DB lookup per request).
- **Security**: No change — auth and tenancy checks remain intact.
- **Data Integrity**: No risk; no existing data is deleted. New data flows for previously-gated tenants.

### Dependencies

- **Upstream**: None
- **Downstream**: loombrain-sessions plugin (which currently detects the string "episodic_memory" in 403 bodies — will be cleaned up in the plugin plan)
- **External**: None

### Breaking Changes

- [x] **None for API consumers** — the change only removes a failure mode. Existing successful calls behave identically. No response shape changes.
- [ ] One database column/field dropped — not a breaking API change but a schema migration. Document in internal changelog.

## Steps to Reproduce (for Bugs)

N/A — this is a product-decision chore, not a bug. The "bug" is that a core feature has an unneeded gate.

## Root Cause Analysis (for Bugs)

N/A — the flag was presumably introduced during episodic memory beta. Now that the feature is core, the gate is obsolete.

## Solution Design

### Approach

**Two-phase deploy for zero-downtime:**

**Phase A (Read-path cleanup):**
1. Locate the captures route handler (`POST /api/v1/captures`).
2. Delete the `episodic_memory` flag check and its 403 branch.
3. Deploy Phase A. Now all tenants can successfully create captures.
4. Verify: no 403-with-episodic_memory responses in logs for 24h.

**Phase B (Schema cleanup):**
1. Add a migration that drops the flag column (or marks it deprecated as a no-op with a default).
2. Remove tenant provisioning code that sets/reads the flag.
3. Remove admin UI/CLI for the flag.
4. Deploy Phase B.

This two-phase approach ensures that even if Phase A and Phase B ship in different weeks, the system is never broken: after Phase A, the flag is ignored; after Phase B, the flag no longer exists.

### Alternatives Considered

1. **Alternative 1: Set all tenants' flag to TRUE instead of removing the flag**
   - Pros: Smaller diff; preserves the flag mechanism for future re-enablement.
   - Cons: Leaves dead code and an always-true check; violates user's explicit directive ("no switch").
   - Why rejected: User's intent is clear — this must become a core feature with no gating mechanism.

2. **Alternative 2: Single-phase deploy (remove check + drop column in one PR)**
   - Pros: One PR instead of two.
   - Cons: Small risk of mid-deploy failures if old replicas still evaluate the flag after the column is gone.
   - Why rejected: Two-phase is safer and low-cost.

3. **Alternative 3: Feature-flag the removal itself**
   - Pros: Ability to revert instantly in production.
   - Cons: Meta-irony; adds complexity.
   - Why rejected: Normal migration rollback is sufficient.

### Data Model Changes

- Drop column `tenants.episodic_memory_enabled` (or equivalent) — exact name TBD by backend engineer
- Migration is reversible (can recreate as BOOLEAN DEFAULT TRUE if rollback needed)

### API Changes

- `POST /api/v1/captures` — no longer returns `403 episodic_memory not enabled`. Response shape unchanged.
- OpenAPI spec: remove any `403` enumeration that referenced the flag.

### UI/UX Changes

- Admin dashboard: remove the tenant flag toggle if one exists.
- End-user UI: no change.

## Implementation Plan

### Phase 1: Foundation & Preparation (COMPLETE FLAG READER INVENTORY)
**Complexity**: 3 | **Priority**: High

<!-- Addressed [Codex High]: Incomplete dependency discovery for flag readers -->

**Phase 1 is not complete until a complete inventory of every flag reader AND writer in the codebase exists. Acceptance for Phase 1: zero remaining occurrences on subsequent greps.**

- [ ] Grep the backend codebase for every reference to the flag name (`episodic_memory_enabled`, `memory:episodic_enabled`, or whatever the actual identifier is). List every file:line that touches the flag. This inventory is a deliverable checked into the PR.
- [ ] Categorize each hit as one of: read path (endpoint/middleware/worker), write path (provisioning/admin), storage (migration/schema), test (to be rewritten or deleted), config/feature-flag system entry.
- [ ] Locate the captures route handler specifically and document its current flag check location.
- [ ] Locate tenant provisioning / seeding code touching the flag.
- [ ] Locate the DB column / storage record.
- [ ] Locate admin UI/CLI surfaces.
- [ ] Confirm with product that the decision applies to ALL plans (free, paid, enterprise).
- [ ] **Pre-migration data scan**: Query current tenant flag distribution (ON / OFF / NULL / missing) and record counts. <!-- Addressed [Codex Medium]: dirty data edge cases -->
- [ ] **Billing confirmation**: If the flag is tied to a paid plan, get written sign-off from billing/product BEFORE starting Phase 2.
- [ ] **Internal tool consumer inventory**: List every consumer of the admin flag control API/CLI. Coordinate removal/update with those consumers. <!-- Addressed [Codex Medium]: internal contract breakage -->

<!-- Addressed [Codex Medium]: phase sequencing ambiguity — collapsed into a single linear sequence with explicit go/no-go gates -->
<!-- Addressed [Codex Critical]: mixed-version deploy — explicit drain gate before migration -->
<!-- Addressed [Codex High]: writer dependency gap — writer removal is pre-requisite for migration -->

### Phase 2: Read-path cleanup + deploy (Deploy A)
**Complexity**: 2 | **Priority**: High

- [ ] Remove the flag check in the captures route handler (read path only)
- [ ] Remove any other read-path code that branched on this flag (use inventory from Phase 1)
- [ ] Write regression tests for unchanged auth/validation/rate-limit paths on POST /captures <!-- Addressed [Codex High]: unchanged error paths -->
- [ ] Write integration test: tenant without flag can create a capture
- [ ] Code review
- [ ] Deploy to staging → verify captures work for a test tenant with flag=OFF AND all error paths (401, 400, 429) unchanged
- [ ] Deploy to production
- [ ] **Gate 1 (24h observation)**: zero `403 episodic_memory` responses in production logs; total captures error rate within ±1% of baseline. If not satisfied → STOP and investigate.

### Phase 3: Write-path cleanup + writer removal
**Complexity**: 3 | **Priority**: High

- [ ] Remove all tenant provisioning / seeder code that sets/reads the flag
- [ ] Remove admin UI / CLI / API that reads/writes the flag, in coordination with internal tool consumers identified in Phase 1
- [ ] Update API documentation (OpenAPI, README, internal docs)
- [ ] Code review
- [ ] Deploy to staging → run smoke tests
- [ ] Deploy to production (writers removed but column still exists)
- [ ] **Gate 2 (writer quiescence)**: confirm no service or job still writes the flag. Grep production deploys, check internal feature-flag system dashboard, verify all admin tool consumers have cut over. If any writer remains → STOP and fix before migration.

### Phase 4: Schema migration (Deploy B)
**Complexity**: 3 | **Priority**: High

- [ ] Write migration:
  - [ ] Snapshot: `INSERT INTO episodic_memory_flag_archive SELECT tenant_id, flag_value, NOW() FROM tenants` (or equivalent backup table) — enables restorable rollback. <!-- Addressed [Codex High]: rollback cannot restore prior states -->
  - [ ] Compute and log tenant-flag-state distribution counts (ON/OFF/NULL) BEFORE drop — emit audit log line
  - [ ] DROP COLUMN (or equivalent schema change)
  - [ ] down migration re-adds column and restores values from `episodic_memory_flag_archive`
- [ ] **Gate 3 (old-version drain)**: confirm ALL production replicas/workers are running the Phase-3 build. Check deploy dashboard; if any old replica exists, wait. <!-- Addressed [Codex Critical]: mixed-version deploy risk -->
- [ ] Run migration on staging → verify archive table populated, column dropped, app still works
- [ ] Run migration on production → immediate smoke test
- [ ] **Gate 4 (24h post-migration)**: error rate nominal; captures still succeeding; no NULL dereference or ORM mapping errors in logs

### Phase 5: Final Validation
**Complexity**: 1 | **Priority**: High

- [ ] Delete the flag code from settings/feature-flag config systems
- [ ] Delete the archive table after a 30-day retention period (track in follow-up ticket)
- [ ] Correlate with plugin log in `~/.loombrain-sessions/capture.log` — expect successful uploads from previously-gated tenants
- [ ] Close this PRD only when Gates 1-4 have all passed

## Relevant Files

### Existing Files

- `<TODO: backend path to captures route handler>`
- `<TODO: backend path to tenant provisioning>`
- `<TODO: backend path to migrations dir>`
- `<TODO: backend path to admin surfaces>`
- `<TODO: backend path to OpenAPI spec>`
- `<TODO: backend path to captures integration tests>`

### New Files

- `<TODO: migration file path>` — drops the flag column

### Test Files

- `<TODO: captures route integration test>` — add tenant-without-flag case
- `<TODO: migration test>` — up/down reversibility

## Testing Strategy

### Unit Tests

- Captures route handler unit tests: existing tests pass; flag-check tests removed (they would test removed code).
- Tenant provisioning tests: ensure no flag field is set.

### Integration Tests

- E2E: POST capture for a tenant where the flag was previously OFF → 201
- E2E: POST capture for a tenant where the flag was previously ON → 201 (unchanged)
- **Unchanged error-path coverage**: POST with invalid payload → 400 (unchanged); POST with bad auth → 401 (unchanged); POST over rate limit → 429 (unchanged); POST for a different tenant's resources → 403 tenant-isolation (unchanged, not episodic-memory). <!-- Addressed [Codex High]: unchanged error paths regression gap -->
- **Dirty-data fixtures**: integration fixtures for tenants with flag=NULL, flag missing (old rows), flag set to unexpected values. All should now succeed with 201 post-migration. <!-- Addressed [Codex Medium]: dirty data edge cases -->
- Migration: run `up`, verify archive table populated with pre-drop snapshot, verify column dropped; run `down`, verify column restored from archive with original per-tenant values.

### E2E Tests

- Real loombrain-sessions plugin against the backend: install plugin, trigger a capture, verify capture appears in the API database.

### Manual Test Cases

1. **Test Case**: Tenant without flag
   - Steps: In staging, create a tenant with the flag explicitly OFF. Install plugin. `/lb:login`. Run a Claude Code session. `/exit`.
   - Expected: Plugin log shows `Capture complete: 1/1 chunk(s) uploaded`. Backend API shows the capture record.

2. **Test Case**: Deploy Phase A only
   - Steps: Deploy Phase A. Do not yet run migration. POST a capture from a previously-OFF tenant.
   - Expected: 201 Created.

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Some internal system still reads the flag after Phase A | Low | Med | Grep the codebase for any reference to the flag name; remove all references in Phase B. |
| Migration fails mid-production | Low | High | Migration is reversible; test on staging with production-sized data. |
| Billing logic depends on flag (episodic memory is a paid feature today) | Med | High | Confirm with product/billing stakeholders BEFORE Phase A. If true, this plan needs a billing side-effect clause. |
| Rate limiting changes when new tenants start capturing | Med | Med | Monitor rate limits during rollout; adjust if needed. |
| Auth layer has a separate flag check | Low | Med | Grep entire auth middleware for the flag string. |
| `[captures-handler::flag-check-removal]` — fails when other handlers or middleware also check the flag; manifests as continued 403s after deploy; fallback: locate and remove remaining checks in a follow-up hotfix. |
| `[migration::drop-column]` — fails when ORM models still reference the column; manifests as deploy-time crash; fallback: two-step migration: first mark column nullable and stop writing to it, then drop in next release. |

### Business Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Episodic memory is actually a paid feature and this removes a revenue gate | Med | High | **BLOCK ON PRODUCT CONFIRMATION** before starting implementation. User directive ("core feature, no switch") suggests this is intentional, but confirm with business side. |
| Sudden increase in write load from previously-gated tenants | Med | Med | Capacity plan: estimate how many tenants were OFF; pre-warm capacity. |
| Data retention / privacy implications of more captures | Low | Med | Existing retention policy applies; no change. |

### Mitigation Strategy

- Block on business confirmation that this is a product decision, not a technical oversight
- Deploy in two phases (read-path first, schema second)
- Monitor for 24h between phases
- Keep migration reversible for one release cycle

## Rollback Strategy

### Rollback Steps

**Phase 2 (Deploy A) rollback:**
1. Revert the PR that removed the flag check
2. Redeploy — the flag check returns, and tenants-without-flag see 403 again

**Phase 3 (writer removal) rollback:**
1. Revert writer-removal PR, redeploy
2. Provisioning / admin controls restored

**Phase 4 (Deploy B + migration) rollback:**
1. Run migration `down`: recreates column and **restores original per-tenant values from `episodic_memory_flag_archive`** — this preserves pre-change state. <!-- Addressed [Codex High]: rollback restore fidelity -->
2. Revert Phase 2 PR (to reinstate the runtime check) if Phase 2 also needs to be reversed
3. Monitor; confirm tenants that previously had flag=OFF are once again seeing 403 (restoring prior behavior, not a new failure mode)
4. **Important**: Rollback is only fully restorable if the archive table was populated successfully in the migration. If the archive step failed, rollback is forward-fix only — flag this in the pre-migration dry run.

### Rollback Conditions

- Phase 2: if removal causes unexpected errors in the captures route (e.g., downstream services depend on the flag)
- Phase 3: if provisioning failures arise from still-existing ORM mappings or cached schema
- Phase 4: if the migration causes ORM failures, data corruption, or unexpectedly high error rate (> 1% deviation)

## Validation Commands

```bash
# Backend — from backend repo root
<TODO: backend test command, e.g., bun test or pytest>
<TODO: migration runner, e.g., bun run migrate or alembic upgrade head>

# From plugin side (after backend deploy), verify the plugin now succeeds:
# On a machine where the tenant previously did not have the flag:
cd plugins/loombrain-sessions
# Trigger a capture (via actual Claude Code session)
tail ~/.loombrain-sessions/capture.log
# Expected: "Capture complete: N/N chunk(s) uploaded" with no "Episodic memory not enabled"
```

## Acceptance Criteria

- [ ] Captures route handler no longer checks the `episodic_memory` flag
- [ ] DB migration drops/deprecates the column
- [ ] Tenant provisioning no longer sets the flag
- [ ] Admin UI/CLI for the flag removed
- [ ] API docs updated
- [ ] Integration tests pass
- [ ] Zero `403 episodic_memory` responses in production for 7 days post-deploy
- [ ] Plugin-side log confirms uploads succeeding for previously-gated tenants

## Dependencies

### New Dependencies

None.

### Dependency Updates

None.

## Notes & Context

### Additional Context

- This plan is the backend counterpart to `plans/plugin-session-capture-resilience.md`.
- The flag manifests to the plugin as a 403 with `episodic_memory` in the response body. Source: `loombrain-sessions/src/api-client.ts:146-147`.
- Research document `research/research-session-capture-ctrl-c-exit.md` captured the log evidence.

### Scope Decision

- **What exists**: A runtime flag check in the captures endpoint, associated storage, provisioning, admin tooling.
- **What's new**: Nothing — this is a deletion plan.
- **Why chosen**: User's explicit product direction: "no switch, core feature."

### Assumptions

- The flag is purely technical and not legally/contractually required (confirm with product/legal).
- The flag storage is a single column or config row, not distributed across multiple systems.
- Backend stack is TypeScript-first per the LoomBrain/Claude Code plugins convention.
- Episodic memory is now a free-tier feature (or pricing adjusted separately).

### Constraints

- Must deploy without downtime.
- Must be reversible for at least one release cycle.
- Must be coordinated with the plugin v0.3.0 release (plugin plan), so that plugin users see the combined benefit.

### Related Tasks/Issues

- Plugin plan: `plans/plugin-session-capture-resilience.md`
- Research: `research/research-session-capture-ctrl-c-exit.md`

### References

- Plugin-side evidence: `plugins/loombrain-sessions/src/api-client.ts:144-152`
- Capture log evidence: `~/.loombrain-sessions/capture.log` (local to the researcher)

### Open Questions

- [ ] What is the exact backend path for the captures route handler?
- [ ] What is the exact name of the flag column/field in the DB?
- [ ] Is this flag tied to a pricing plan? If yes, has billing signed off on making it free?
- [ ] Are there any other endpoints that check this flag (e.g., search, retrieval of episodic memories)?
- [ ] Should we preserve the flag as a read-only audit field for one release before dropping?
- [ ] What is the current count of tenants with flag=OFF? (Useful for capacity planning.)

## Blindspot Review

**Reviewers**: GPT-5.3-Codex (xhigh). Gemini 3 Pro **unavailable** (API returned 429 "exhausted capacity" across 10 retries, 2026-04-11 20:21 UTC). Proceeding with Codex-only review; rerun Gemini when capacity is restored.
**Date**: 2026-04-11
**Plan Readiness**: Was "Needs Revision" per Codex initial assessment (11 findings). After revisions below, plan addresses all Critical and High findings plus the straightforward Medium findings.

### Addressed Concerns

- **[Codex, Critical] Mixed-version deploy risk around column drop** → Phase 3/4 split: writer removal happens BEFORE migration; Gate 3 requires all replicas on writer-removed build before migration runs.
- **[Codex, High] Rollback cannot restore prior tenant states** → Migration now snapshots to `episodic_memory_flag_archive` table BEFORE drop; `down` restores values from the archive. Rollback Strategy updated.
- **[Codex, High] Incomplete flag reader inventory** → Phase 1 now requires a complete grep-based inventory as a checked-in deliverable; zero remaining occurrences is the Phase 1 acceptance gate.
- **[Codex, High] Testing misses unchanged error paths** → Phase 2 adds explicit regression tests for 401/400/429/tenant-isolation. Added to Quality Gates in Success Metrics.
- **[Codex, High] Writer dependency gap during Phase A→B window** → New Gate 2 requires writer removal to be verified in production before migration runs.
- **[Codex, Medium] Audit count operationally ambiguous** → FR-5 rewritten: compute counts BEFORE drop, emit deterministic log line from migration itself.
- **[Codex, Medium] Edge cases for dirty tenant flag data** → Phase 1 adds pre-migration data scan; Integration Tests add fixtures for NULL/missing/unknown states.
- **[Codex, Medium] Priority conflict for admin control removal** → FR-4 raised to Must Have to match acceptance criteria.
- **[Codex, Medium] Success metric can mask new failure modes** → Added total error rate within ±1% of baseline as a secondary metric.
- **[Codex, Medium] Internal contract breakage from admin tool removal** → Phase 1 adds internal tool consumer inventory as a prerequisite.
- **[Codex, Medium] Phase sequencing internally inconsistent** → Phases collapsed into a single linear sequence with explicit Gates 1-4 for go/no-go decisions.

### Acknowledged but Deferred

- None.

### Dismissed

- None.

### Gemini Re-run Plan

If Gemini capacity returns within 24h, rerun the critic with the revised plan and update this section with any new findings.
