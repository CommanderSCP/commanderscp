# ADR-0053: A build's destination is derived from its Type's artifact class, and a registry that cannot hold it is refused

**Status:** Accepted (2026-09-23) — realizes M28 decision D1; the Type→class table and the no-class rule below are this increment's calls, and the owner is invited to overrule them
**Relates to:** [ADR-0007](0007-executor-binding-type-taxonomy.md) (the Type taxonomy this routes on); [ADR-0012](0012-registry-consolidation.md) (Gitea as the unified registry — the reason formats are a list); [ADR-0049](0049-machine-image-publication.md) (`vm-image` publishes to an image store); BUILD_AND_TEST.md §8 M28 / M28.1

## Context

`buildLaneTriggerParameters` derived a destination for the whole `build` **Category**: every build
trigger whose component had a `publishes_to` edge was handed `imageRepository`, `imageDestination`
(`host/repository`) and `dockerfile`. An `rpm` build was therefore told to push to a container
registry — a wrong answer, not a missing one, and the defect M28.1 exists to correct. It was
asserted red first (`build-trigger-parameters.integration.test.ts`: `expected { handed: { …(8) } }
to not have property "handed.imageDestination"`, received `"ghcr.io/acme/widget"`).

D1 had already decided the shape: an RPM's destination is a `registry` with a package-repo kind,
reached by the existing `publishes_to` edge, as registry data rather than a new table. What D1 did
not say is where the "kind" lives, and the obvious place is taken: a registry is an
`execution-system` object, and its `properties.kind` is the **product** (`gitea`, `harbor`, `ghcr`)
— which cannot answer the question, because ADR-0012 makes one Gitea the image registry *and* the
RPM registry *and* the npm registry.

## Decision

**1. A registry declares the formats it serves: `properties.packageFormats`, a list.** Read
verbatim (`readPackageFormats` in `component-pipeline.ts`) and surfaced on the pipeline view's
`registry` as `packageFormats` (additive, optional on the wire). A unified Gitea declares
`["oci","rpm"]`. It is a list and not a scalar precisely so the unified registry is **one** object,
as ADR-0012 intends; a scalar would force an operator to register the same Gitea twice.

- **Absent ⇒ `["oci"]`** (`DEFAULT_REGISTRY_PACKAGE_FORMATS`). Every registry that existed before
  this increment was a container registry, so this is the default under which they keep working
  with **no operator action** — asserted by *"a registry that declares nothing is still a container
  registry, so `image` is unchanged"*. The view reports `null` (declared nothing), not `["oci"]`: the
  default is the build lane's reading, and the tile says what was declared.
- **Present but not a list of strings ⇒ `[]`, serves nothing.** A bare `"rpm"` is not repaired into
  `["rpm"]`; a malformed declaration is refused with a sentence that names it, rather than guessed at.

**2. The Type selects a destination format (`DESTINATION_FORMAT_OF_TYPE`, `@scp/schemas`).**

| Type | Destination format | Destination parameters SCP derives | Why |
|---|---|---|---|
| `image` | `oci` | `imageRepository`, `imageDestination` (`host/repository`), `registryUrl`, `registryName`; `dockerfile` from `properties.dockerfile` | Unchanged — byte-for-byte what it got before. |
| `rpm` | `rpm` | `packageRepository` (`owner[/group]`), `rpmUploadUrl`, `rpmRepositoryUrl`, `registryUrl`, `registryName`; `rpmSpec` from `properties.rpmSpec` | D1. Gitea's RPM registry is per owner, optionally grouped (`el9`, `el9/stable`). |
| `chart` | none | none | `helm push` addresses a registry *namespace* (`oci://host/owner`) and takes the repository from Chart.yaml, so the `host/repository` shape SCP assembles for images is not its input; a classic chart repo is not OCI at all. Charts *can* live in OCI — the right parameters are a chart-template increment's call, not a guess made here. |
| `vm-image` | none | none | Publishes to an image store (ADR-0049), never an OCI registry. |
| `deb`, `npm`, `maven`, `python`, `go` | none | none | No shipped template and no modelled destination. |

`dockerfile` is now carried only for `image`: a Dockerfile path handed to an RPM build is the same
class of wrong answer as an image destination.

**3. Refusal semantics.**

- A Type **with** a format, whose `declared` registry does not serve it, is **refused**
  (`BuildDestinationRefused`). So is an `rpm` registry of any kind but `gitea`: an RPM upload
  address is product-shaped (Gitea `PUT …/api/packages/{owner}/rpm[/{group}]/upload`; Pulp and Nexus
  differ), and SCP derives only the shape it knows rather than guessing another product's API.
- A Type **with no** format derives no destination and **does not consult the registry at all** — it
  is neither handed a container registry (the defect) nor refused over one. This is a deliberate
  reading of "a mismatched registry is refused rather than guessed": with no destination class there
  is no basis on which to call any registry mismatched, and refusing would be the guess in the other
  direction. The `publishes_to` edge stays a descriptive graph fact for the view. It also keeps every
  existing IaC-authored `npm`/`deb`/… pipeline working: `@scp/coordination-as-code` emits a default
  `publishes_to` edge for every build kind, so refusing those would break estates that were never
  handed anything usable. When a Type gains a format (with its template), its refusal arrives with it.
- `none` (no edge) and `ambiguous` (several) are unchanged: no destination, and a template that
  requires one refuses at submit.

**4. A refusal is a terminal Decision, not a retry.** `BuildDestinationRefused` extends a typed
`TriggerParameterRefusal`; `reconcile.ts` catches that class only (`asRefusal`) and terminalises the
wave target through `blockWaveTarget` — Decision with its inputs (`gate: build_destination_format`,
the Type, the required format, the declared and effective formats), hash-chained audit event
`change.wave_target.destination_refused` carrying the `decision_id`, status `destination_refused`,
change parked — and `trigger()` is never called. Any other error still takes the retry path.

**4a. A recipe may not restate the destination, and this narrows "the recipe wins".** reconcile
merges a campaign recipe's `trigger.parameters` OVER the derived ones, deliberately: a recipe is an
operator's explicit instruction, and silently overriding it would make the authored document a lie.
That is right for conveniences and wrong for a destination. Without a bound, a proposer could put
`properties.recipe.trigger.parameters.rpmUploadUrl` (or `imageDestination`, or `registryUrl`) on an
`rpm` change and publish anywhere — a container registry included — around the very refusal above.
It was observed doing exactly that (the plugin submitted the recipe's URL) before this bound.

So for a Type whose destination SCP derives (`image`, `rpm`), a recipe naming any key in
`BUILD_DESTINATION_PARAMETER_KEYS` — every key `destinationParameters` can emit — is **refused**
through the same typed path: Decision `gate: build_destination_recipe` carrying the offending key
NAMES (never their values), audit `change.wave_target.destination_refused`, never triggered. Refused
rather than silently overridden, for the same reason the recipe wins elsewhere: an author who wrote a
destination believed it would be used, and quietly discarding it would be the lie the merge rule
exists to avoid. It is checked BEFORE the registry is read, so it also fires when the component
declares no registry — the case where the recipe's value would be the only destination the executor
saw. A no-class Type's recipe is untouched: SCP derives no destination for it, so there is nothing to
protect. The key list is one exported constant so M28.4's server-reserved-keys table can absorb it.
This is the build-lane twin of ADR-0052, narrower in effect (refuse, not win) because a build
destination has a declared source of truth — the graph — to point the author at.

**Census by property.** `OpsDeclarationRefused` (M27.9) had the same property — thrown inside the
claim transaction, caught by the per-target handler, logged and retried every tick with no Decision.
It now extends the same class and terminalises as `ops_declaration_refused`. Its Decision carries `{ gate: "ops_declaration", reason, role, hasArguments }` — the cause from a closed set, never the argument values (they can name hosts and paths) — and `ops-declaration-refusal.integration.test.ts` proves the path through the real reconcile loop with a real `managed-ops` binding. Both statuses joined
`REFUSED_WAVE_TARGET_STATUSES`, which is what every terminal-skip and board projection reads.

**5. `scp-build-rpm-v1` and its builder.** A catalog `WorkflowTemplate` beside `scp-build-image-v1`:
the identical fetch-by-commit init container (helm-verify asserts they stay identical), then
`scp-builder-rpm` running `build-rpm.sh` — SRPM from the spec, RPM **from the SRPM** (proving the
SRPM is self-contained), one `PUT` per binary RPM. Credentials come from the operator's existing
`credentialsSecret` (`registryUsername`/`registryPassword`, the image template's keys — a unified
Gitea takes one identity); SCP holds none.

- **First-party image**, because no maintained public image ships `rpmbuild` (measured: `fedora:43`,
  `fedora-toolbox:43`, `almalinux:9` all lack `rpm-build`) and a run-time `dnf install` is impossible
  air-gapped. EL9 (AlmaLinux 9, digest-pinned) because an RPM is built for the distribution it is
  built on. The toolchain is fixed; a spec needing more fails at rpmbuild's own `BuildRequires` check.
- **Zero securityContext relaxations**, measured the image template's way (run hardened, read each
  denial): non-root, read-only root, `drop: [ALL]`, `allowPrivilegeEscalation: false`,
  `RuntimeDefault`. The only two denials were writes (`/var/tmp` scriptlets, `find-debuginfo`'s
  `/tmp`) and were fixed by pointing them at the workspace. Measured under Docker's defaults, not
  yet on the cluster's runtime (that needs an owner-applied install).
- **Off until its image is named** (`catalog.buildRpm.builderImage`, empty by default). The air-gap
  `install.sh` sets it from the bundle; a connected install passes the ref `publish-images` prints
  (`scp-bundled.sh enable argo-workflows --set …builderImage=ghcr.io/commanderscp/scp-builder-rpm:sha-<commit>@sha256:<digest>`).
  No chart default, like every managed runner image: first-party images are published only as
  `sha-<commit>`, so no versioned ref a default could name is guaranteed to exist.
- **"Signed"** means what it means for `scp-build-image-v1`: the template ships in
  `deploy/helm-bundled`, which the air-gap bundle carries under its cosign-signed `CHECKSUMS.txt` and
  signed tarball. Neither catalog template carries a per-template signature.
- A republish of the same NEVRA fails (Gitea answers 409): an RPM version is immutable, so the fix
  is the spec's `Release`, and the script says so rather than swallowing it.

## Consequences

- An `rpm` component promotes end to end: `rpm-build-lane.integration.test.ts` drives a change
  through the real reconcile loop and the real `argo-workflows` plugin, then runs the shipped builder
  with exactly the submitted parameters against a real Gitea and `dnf install`s the result.
- A campaign recipe still wins a key collision on the build lane for every key EXCEPT the derived
  destination keys (§4a), which it may not name at all for an `image` or `rpm` target.
- Registering an RPM destination is data only: add `rpm` to the registry's `packageFormats` and
  point the component's `publishes_to` edge at it with `repository: owner[/group]`.

## Addendum (2026-09-24, M28.3 verification) — the build builds only a DECLARED source

The adversarial verification of PR #415 found the infrastructure lane running whatever repo a
proposer named with the operator's credentials; census by property found the build lane has the same
property. `buildLaneTriggerParameters` passed `sourceRef.repo` straight through, and the build
template runs that repo's own Dockerfile or spec and pushes the result with the operator's push
credentials — a proposer could publish any repository under a component's name.

**The repo is now checked against the component's declared sources for the build's Type**: its
`source_mappings` rows of that Type (the same rows that route a push to it, matched the same way —
a glob on the repo, a NULL pattern meaning every repo; disabled rows still declare). A repo — the
change's `sourceRef.repo` or a recipe's `sourceRepo`, which wins the merge in reconcile — that no
row matches is refused, terminal, `source_refused` with a Decision (`BuildSourceRefused`).

**A component with NO source mapping of that Type is REFUSED** (`build_source_undeclared`) — owner
ruling R2, 2026-09-24, replacing the first version's warn-and-proceed (which also wrote a warn
Decision per claim).

**And the repo must be in the binding's EXECUTION SYSTEM's source allowlist** (owner ruling R1;
ADR-0056 §7a): a component's editor can add a source mapping, so the mapping alone would be the
proposer vouching for themselves. The allowlist is written only with `secret:write` at the org root.
An inline binding has no allowlist and is refused (`build_source_no_execution_system`); a repo the
system does not allow is refused (`build_source_not_allowed`). The fake executor runs nothing and is
not checked. Before deploying this, every build component coordinated through a real executor needs
(a) a source mapping of its Type naming its repo, and (b) that repo in its execution system's
allowlist — and must be bound through an execution system, not inline.
