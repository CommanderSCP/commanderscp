import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleHelp, ExternalLink, Package } from "lucide-react";
import type {
  DeclareDependencyLineProducerRequest,
  DependencyEcosystem,
  DependencyLineProducerVerbResponse,
  DependencyLineProducerView,
  DependencyProducerLineImpact,
  GraphObject,
  RetractDependencyLineProducerRequest
} from "@scp/schemas";
import { ScpApiError } from "@scp/sdk";
import { client } from "../lib/client";
import { useAuth } from "../lib/auth-context";
import { dependencyProducersKey } from "../lib/query-client";
import { cn, focusRing } from "../lib/utils";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { PageHeader } from "../components/ui/page-header";
import { SectionLabel } from "../components/ui/section-label";
import { Skeleton } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../components/ui/table";
import { QueryErrorNotice, queryErrorMessage } from "../components/query-error";
import { WhyLink } from "../components/decision/WhyLink";
import { decisionIdOf } from "../components/decision/decision-format";
import { ManagedAtCommanderNotice, type ReadState } from "./component-dependencies";

/**
 * ADMIN › DEPENDENCIES — the org's dependency PRODUCER declarations
 * (docs/proposals/dependency-subscription-ui.md §12; ADR-0032 §7e; server route
 * `apps/server/src/routes/dependency-producers.ts`).
 *
 * "Dependency producers — which components this org publishes which coordinates from." A
 * declaration is PER COORDINATE (every major, present and future): it removes the coordinate from
 * third-party polling and CLEARS every covered line's observed head (both verbs — a stale head is an
 * M22 vendor-scan-rule input). The blast radius is the set of components subscribed to those lines,
 * unguessable from the request, which is why the dialogs here run `dryRun: true` FIRST and only
 * then offer the write: the Declare button is enabled only after a preview for the SAME
 * ecosystem / coordinate / producer, and editing any field invalidates it. Not a nicety.
 *
 * COMMANDER SITE ONLY (owner rule 2026-08-17: dependency automation happens only at the commander).
 * The nav carries the entry on the commander table alone; a direct URL on any other install-time
 * role renders `ManagedAtCommanderNotice` (the same reason-aware pointer the Dependencies tab
 * renders) and issues NO reads. On the commander the WIRE is honoured too: a list answer whose
 * `dependencyManagement.managedHere` is false renders the pointer with the server's reason and no
 * table — never an empty table that would read as "nothing declared".
 *
 * WRITES ARE OFFERED, REFUSALS RENDERED (M16.3 rule): Declare… and Retract… render for every viewer;
 * the server's own sentence is shown for every refusal — 400 (a `service`, not a `component`;
 * nothing to retract), 404 (producer unresolvable in this org), 403 (`policy:write` at the org
 * root), 409 (not a commander on the federation axis). A retraction stops FUTURE triggers only: the
 * REAL response's `openBumpAuthorships[]` are pull requests SCP already opened in other teams'
 * repositories and never closes, so that list is rendered as "still in flight" and the dialog stays
 * open on it until dismissed — it is the operator's take-away.
 *
 * Every name rendered (producer, declarer, subscribed components) is READ off the server's enriched
 * response (§12.6 Q1) — never looked up N+1 from here, never inferred.
 */

export const ECOSYSTEMS: readonly DependencyEcosystem[] = ["npm", "go", "maven", "python", "oci"];

/** The exact empty-state sentence (§12.3.2) — rendered ONLY after a successful zero-row read. */
export const NO_PRODUCERS_SENTENCE =
  "No producers declared. Every coordinate in this org is polled as third-party.";

/** The exact no-lines sentence in a preview (§12.3.3). */
export const NO_LINES_SENTENCE =
  "no lines yet — this coordinate has not been seen in any manifest; the declaration still takes effect for every future major";

const selectClass = cn(
  "flex h-9 w-full rounded-md border border-slate-300 bg-white px-3 py-1 text-sm shadow-sm",
  focusRing
);

/** Relative age for the Declared column ("3 days ago"); the ISO instant rides on `title`. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((now - then) / 1000);
  const abs = Math.abs(seconds);
  const suffix = seconds >= 0 ? "ago" : "from now";
  if (abs < 45) return seconds >= 0 ? "just now" : "in a moment";
  const spans: [number, string][] = [
    [1, "second"],
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [2592000, "month"],
    [31536000, "year"]
  ];
  let chosen: [number, string] = spans[0]!;
  for (const span of spans) if (abs >= span[0]) chosen = span;
  const n = Math.round(abs / chosen[0]);
  return `${n} ${chosen[1]}${n === 1 ? "" : "s"} ${suffix}`;
}

/**
 * How a producer verb's refusal is rendered (charter principle 6). 403 → names `policy:write` AT
 * THE ORG ROOT (the route's authority; custody of the producing component is deliberately not
 * enough) plus the server's detail; 409 → the server's sentence (not a commander on the federation
 * axis) plus a Why link when the problem carried a `decision_id`; 400 / 404 → the server's sentence
 * verbatim (a `service` is refused and the message says why; an unresolvable producer names the org).
 * Never a fabricated Why link.
 */
export function producerWriteRefusal(error: unknown): { message: string; decisionId?: string } {
  if (error instanceof ScpApiError) {
    const detail = error.problem?.detail ?? error.message;
    if (error.status === 403) {
      return { message: `Refused: this needs policy:write at the org root. ${detail}` };
    }
    const decisionId = decisionIdOf(error);
    if (error.status === 409) {
      return decisionId
        ? { message: `Refused: ${detail}`, decisionId }
        : { message: `Refused: ${detail}` };
    }
    return decisionId ? { message: detail, decisionId } : { message: detail };
  }
  return { message: queryErrorMessage(error) };
}

function RefusalAlert({
  error,
  testId
}: {
  error: unknown;
  testId: string;
}): React.JSX.Element | null {
  if (error === null || error === undefined) return null;
  const refusal = producerWriteRefusal(error);
  return (
    <Alert tone="danger" data-testid={testId}>
      {refusal.message}
      {refusal.decisionId ? (
        <>
          {" "}
          <WhyLink decisionId={refusal.decisionId} data-testid={`${testId}-why`} />{" "}
          <span className="font-mono text-xs" data-testid={`${testId}-decision-id`}>
            {refusal.decisionId}
          </span>
        </>
      ) : null}
    </Alert>
  );
}

// -------------------------------------------------------------------------------------------
// The blast-radius report — shared by both dialogs. READ off the verb response, never derived.
// -------------------------------------------------------------------------------------------

/**
 * Per covered line: its major, the head that stood BEFORE (what the write clears — `headCleared`
 * says whether there was one), and the subscribed components BY NAME (id fallback; "none
 * subscribed" when empty). An empty `lines[]` is ordinary and says so in the exact §12.3.3 sentence.
 */
export function BlastRadiusReport({
  lines,
  verb
}: {
  lines: readonly DependencyProducerLineImpact[];
  verb: "declare" | "retract";
}): React.JSX.Element {
  if (lines.length === 0) {
    return (
      <p className="text-sm text-slate-600" data-testid="blast-radius-no-lines">
        {verb === "declare"
          ? NO_LINES_SENTENCE
          : "no lines — this coordinate has not been seen in any manifest; nothing subscribed is affected"}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="blast-radius">
      <p className="text-xs text-slate-500">
        {lines.length} major line{lines.length === 1 ? "" : "s"} covered — each line's observed head
        is cleared and its subscribers are the repositories this reaches.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Major</TableHead>
            <TableHead>Head before (cleared)</TableHead>
            <TableHead>Subscribed components</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => (
            <TableRow key={line.lineId} data-testid="blast-radius-line">
              <TableCell className="font-mono text-xs text-slate-900">{line.major}</TableCell>
              <TableCell
                className="font-mono text-xs text-slate-600"
                data-testid="blast-radius-head"
              >
                {line.headBefore.latestVersion ?? (
                  <span
                    className="text-slate-400"
                    title="No observed head on this line — nothing to clear."
                  >
                    —
                  </span>
                )}
                {line.headCleared ? (
                  <span className="ml-2 text-xs text-amber-700">will be cleared</span>
                ) : (
                  <span className="ml-2 text-xs text-slate-400">no head to clear</span>
                )}
              </TableCell>
              <TableCell className="text-xs text-slate-700" data-testid="blast-radius-subscribers">
                {line.subscribedComponents.length === 0 ? (
                  <span className="text-slate-500">none subscribed</span>
                ) : (
                  line.subscribedComponents.map((c, i) => (
                    <span key={c.objectId}>
                      {i > 0 ? ", " : ""}
                      {c.name || c.objectId}
                    </span>
                  ))
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Declare… dialog.
// -------------------------------------------------------------------------------------------

/** The producer picker's data — the components list as the dialog sees it. */
export type ComponentsRead = ReadState<readonly GraphObject[]>;

/**
 * Cursor paging for the picker (dependency-subscription-ui.md §12 paging note). `components` above
 * carries only the pages read so far — the first page loads eagerly (`limit: 100`,
 * `ObjectListQuerySchema`'s max), and `onLoadMore` fetches the next one via the cursor the SERVER
 * returned (`nextCursor`), never a client-guessed offset. `loading` disables the affordance so a
 * double-click cannot start a second fetch — there is exactly one in-flight page at a time, never a
 * parallel unbounded loop.
 */
export interface ComponentsLoadMore {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}

function componentMatches(c: GraphObject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return c.name.toLowerCase().includes(q) || c.urn.toLowerCase().includes(q) || c.id === q;
}

/**
 * The declare dialog's CONTENT, portal-free — exported for the test. Two steps, and the second is
 * GATED on the first: "Preview blast radius" runs the verb with `dryRun: true` and renders the
 * report; "Declare" runs it for real, and is enabled ONLY while a preview exists for the SAME
 * ecosystem / coordinate / producer (editing any field invalidates it). `run` is the SDK verb,
 * threaded in so the body stays provider-free.
 */
export function DeclareDialogBody({
  components,
  componentsLoadMore,
  run,
  onDeclared,
  onCancel
}: {
  components: ComponentsRead;
  componentsLoadMore: ComponentsLoadMore;
  run: (req: DeclareDependencyLineProducerRequest) => Promise<DependencyLineProducerVerbResponse>;
  onDeclared: (response: DependencyLineProducerVerbResponse) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [ecosystem, setEcosystem] = useState<DependencyEcosystem>("npm");
  const [coordinate, setCoordinate] = useState("");
  const [producerQuery, setProducerQuery] = useState("");
  const [producerPick, setProducerPick] = useState<{ id: string; name: string } | null>(null);
  const [preview, setPreview] = useState<{
    key: string;
    response: DependencyLineProducerVerbResponse;
  } | null>(null);
  const [busy, setBusy] = useState<"preview" | "declare" | null>(null);
  const [error, setError] = useState<unknown>(null);

  // A typed id / URN is sent as-is when no listed component was picked — the server resolves it
  // (and refuses a service with a 400 that is rendered here); the picker itself lists components only.
  const producerIdOrUrn = producerPick ? producerPick.id : producerQuery.trim();
  const previewKey = [ecosystem, coordinate, producerIdOrUrn].join("\u0000");
  const complete = coordinate.trim() !== "" && producerIdOrUrn !== "";
  const previewCurrent = preview !== null && preview.key === previewKey;

  const request = (dryRun: boolean): DeclareDependencyLineProducerRequest => ({
    ecosystem,
    coordinate,
    producerIdOrUrn,
    ...(dryRun ? { dryRun: true } : {})
  });

  const doPreview = async () => {
    setBusy("preview");
    setError(null);
    const key = previewKey;
    try {
      const response = await run(request(true));
      setPreview({ key, response });
    } catch (e) {
      setPreview(null);
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const doDeclare = async () => {
    // Belt and braces beside the disabled button: the real write never fires without a current
    // preview, whatever dispatched the click.
    if (!previewCurrent) return;
    setBusy("declare");
    setError(null);
    try {
      const response = await run(request(false));
      onDeclared(response);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const matches =
    components.status === "ok"
      ? components.data.filter((c) => componentMatches(c, producerQuery))
      : [];

  return (
    <>
      <div className="flex flex-col gap-3 text-sm text-slate-600" data-testid="declare-body">
        <p>
          Declares that a component of this org PRODUCES a coordinate: every major line of it —
          present and future — stops being polled as third-party, its observed heads are cleared,
          and releases of the producer drive the subscribed components' bumps instead.
        </p>
        <label className="block">
          <SectionLabel as="span">Ecosystem</SectionLabel>
          <select
            className={`${selectClass} mt-1`}
            value={ecosystem}
            disabled={busy !== null}
            onChange={(e) => setEcosystem(e.target.value as DependencyEcosystem)}
            data-testid="declare-ecosystem"
          >
            {ECOSYSTEMS.map((eco) => (
              <option key={eco} value={eco}>
                {eco}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <SectionLabel as="span">Coordinate</SectionLabel>
          <Input
            className="mt-1 font-mono"
            value={coordinate}
            disabled={busy !== null}
            onChange={(e) => setCoordinate(e.target.value)}
            placeholder="@acme/lib"
            data-testid="declare-coordinate"
          />
          <span className="mt-1 block text-xs text-slate-500" data-testid="declare-coordinate-help">
            Verbatim, as the ecosystem spells it — never slugified: <code>@acme/lib</code>,{" "}
            <code>github.com/acme/lib</code>, <code>docker.io/library/alpine</code>.
          </span>
        </label>
        <div className="block">
          <SectionLabel as="span">Producer (component)</SectionLabel>
          <Input
            className="mt-1"
            value={producerQuery}
            disabled={busy !== null}
            onChange={(e) => {
              setProducerQuery(e.target.value);
              setProducerPick(null);
            }}
            placeholder="Search components by name or URN, or paste an id / URN"
            data-testid="declare-producer-search"
          />
          {producerPick ? (
            <p className="mt-1 text-xs text-slate-700" data-testid="declare-producer-picked">
              Selected: <span className="font-medium">{producerPick.name}</span>{" "}
              <span className="font-mono text-slate-500">{producerPick.id}</span>
            </p>
          ) : components.status === "pending" ? (
            <Skeleton className="mt-1 h-5 w-40" data-testid="declare-producer-pending" />
          ) : components.status === "error" ? (
            <Badge
              variant="unknown"
              icon={CircleHelp}
              className="mt-1"
              title={`The components list could not be read: ${queryErrorMessage(components.error)}. An id or URN typed above is still sent as-is.`}
              data-testid="declare-producer-unreadable"
            >
              Components could not be listed
            </Badge>
          ) : (
            <ul
              className="mt-1 max-h-40 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200"
              data-testid="declare-producer-matches"
            >
              {matches.slice(0, 25).map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full flex-col items-start px-2 py-1 text-left hover:bg-slate-50",
                      focusRing
                    )}
                    onClick={() => {
                      setProducerPick({ id: c.id, name: c.name });
                      setProducerQuery(c.name);
                    }}
                    data-testid="declare-producer-match"
                    data-id={c.id}
                  >
                    <span className="text-sm text-slate-900">{c.name}</span>
                    <span className="font-mono text-xs text-slate-500">{c.urn}</span>
                  </button>
                </li>
              ))}
              {matches.length === 0 ? (
                <li
                  className="px-2 py-1 text-xs text-slate-500"
                  data-testid="declare-producer-none"
                >
                  No listed component matches
                  {producerQuery.trim() !== ""
                    ? " — the text above is sent as an id / URN as typed."
                    : "."}
                </li>
              ) : null}
            </ul>
          )}
          {components.status === "ok" && componentsLoadMore.hasMore ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1"
              disabled={componentsLoadMore.loading}
              onClick={componentsLoadMore.onLoadMore}
              data-testid="declare-producer-load-more"
            >
              {componentsLoadMore.loading
                ? "Loading…"
                : `Load more (${components.data.length} loaded)`}
            </Button>
          ) : null}
        </div>

        {previewCurrent ? (
          <div
            className="flex flex-col gap-2 rounded-md border border-slate-200 p-3"
            data-testid="declare-preview"
          >
            <SectionLabel as="span">Blast radius (preview — nothing written)</SectionLabel>
            <BlastRadiusReport lines={preview.response.lines} verb="declare" />
          </div>
        ) : preview !== null ? (
          <p className="text-xs text-amber-700" data-testid="declare-preview-stale">
            The preview was for different values — preview again before declaring.
          </p>
        ) : null}

        <RefusalAlert error={error} testId="declare-error" />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy !== null}>
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={() => void doPreview()}
          disabled={busy !== null || !complete}
          data-testid="declare-preview-run"
        >
          {busy === "preview" ? "Previewing…" : "Preview blast radius"}
        </Button>
        <Button
          onClick={() => void doDeclare()}
          disabled={busy !== null || !previewCurrent}
          data-testid="declare-confirm"
        >
          {busy === "declare" ? "Declaring…" : "Declare"}
        </Button>
      </DialogFooter>
    </>
  );
}

// -------------------------------------------------------------------------------------------
// Retract… dialog.
// -------------------------------------------------------------------------------------------

/**
 * The retract dialog's CONTENT, portal-free — exported for the test. Runs the preview
 * (`dryRun: true`) on open — there is nothing to type, the report IS the question — and offers
 * Retract only once it has resolved. After the REAL retract the response's `openBumpAuthorships[]`
 * (bumps SCP already dispatched — pull requests in other teams' repositories that a retraction does
 * NOT close) is rendered as "still in flight" with the Decision id, and the body stays until
 * dismissed: that list is the operator's take-away.
 */
export function RetractDialogBody({
  producer,
  run,
  onRetracted,
  onClose
}: {
  producer: DependencyLineProducerView;
  run: (req: RetractDependencyLineProducerRequest) => Promise<DependencyLineProducerVerbResponse>;
  onRetracted: (response: DependencyLineProducerVerbResponse) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState<DependencyLineProducerVerbResponse | null>(null);
  const [result, setResult] = useState<DependencyLineProducerVerbResponse | null>(null);
  const [busy, setBusy] = useState<"preview" | "retract" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  const key: RetractDependencyLineProducerRequest = {
    ecosystem: producer.ecosystem,
    coordinate: producer.coordinate
  };

  const doPreview = async () => {
    setBusy("preview");
    setError(null);
    try {
      setPreview(await run({ ...key, dryRun: true }));
    } catch (e) {
      setPreview(null);
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  // Runs ONCE per open (the ref guards a re-run; the view keys the body on the coordinate, so a
  // different row is a fresh mount): the dialog's first act is the dry run.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void doPreview();
  }, []);

  const doRetract = async () => {
    if (preview === null) return;
    setBusy("retract");
    setError(null);
    try {
      const response = await run(key);
      setResult(response);
      onRetracted(response);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-3 text-sm text-slate-600" data-testid="retract-body">
        <p>
          Retracts the declaration that{" "}
          <span className="font-medium text-slate-900">
            {producer.producer.name || producer.producerObjectId}
          </span>{" "}
          produces{" "}
          <span className="font-mono text-slate-900">
            {producer.ecosystem} {producer.coordinate}
          </span>
          . The coordinate returns to third-party polling and every covered line's observed head is
          cleared. Retraction stops FUTURE triggers only — bumps already dispatched are reported
          below and never closed by SCP.
        </p>

        {result ? (
          <div
            className="flex flex-col gap-2 rounded-md border border-slate-200 p-3"
            data-testid="retract-result"
          >
            <Notice tone="success" data-testid="retract-success">
              Retracted.{" "}
              {result.decisionId ? (
                <>
                  <WhyLink decisionId={result.decisionId} data-testid="retract-why" />{" "}
                  <span className="font-mono text-xs" data-testid="retract-decision-id">
                    {result.decisionId}
                  </span>
                </>
              ) : null}
            </Notice>
            <SectionLabel as="span">Still in flight — SCP does not close these</SectionLabel>
            {result.openBumpAuthorships.length === 0 ? (
              <p className="text-xs text-slate-500" data-testid="retract-open-bumps-none">
                No bumps were in flight for this coordinate at the moment of retraction.
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="retract-open-bumps">
                {result.openBumpAuthorships.map((b) => (
                  <li
                    key={`${b.changeObjectId}:${b.manifestPath}`}
                    className="font-mono text-xs text-slate-700"
                    data-testid="retract-open-bump"
                  >
                    {b.repo} · {b.manifestPath} · {b.fromVersion} → {b.toVersion}
                    {b.pullRequestUrl ? (
                      <>
                        {" "}
                        <a
                          href={b.pullRequestUrl}
                          className={cn(
                            "inline-flex items-center gap-1 rounded underline",
                            focusRing
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="retract-open-bump-pr"
                        >
                          pull request
                          <ExternalLink className="size-3.5" strokeWidth={2} aria-hidden="true" />
                        </a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : preview ? (
          <div
            className="flex flex-col gap-2 rounded-md border border-slate-200 p-3"
            data-testid="retract-preview"
          >
            <SectionLabel as="span">Blast radius (preview — nothing written)</SectionLabel>
            <BlastRadiusReport lines={preview.lines} verb="retract" />
          </div>
        ) : busy === "preview" ? (
          <Skeleton className="h-10 w-full" data-testid="retract-preview-pending" />
        ) : null}

        <RefusalAlert error={error} testId="retract-error" />
      </div>
      <DialogFooter>
        {result ? (
          <Button onClick={onClose} data-testid="retract-close">
            Done
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose} disabled={busy !== null}>
              Cancel
            </Button>
            {error !== null && preview === null ? (
              <Button
                variant="outline"
                onClick={() => void doPreview()}
                disabled={busy !== null}
                data-testid="retract-preview-retry"
              >
                Retry preview
              </Button>
            ) : null}
            <Button
              variant="destructive"
              onClick={() => void doRetract()}
              disabled={busy !== null || preview === null}
              data-testid="retract-confirm"
            >
              {busy === "retract" ? "Retracting…" : "Retract"}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

// -------------------------------------------------------------------------------------------
// The table and the view (provider-free), and the page (hooks).
// -------------------------------------------------------------------------------------------

/** The dialog descriptions — Radix portals them away from a static render, so they are strings. */
export const DIALOG_COPY = {
  declare:
    "Runs a dry run first — the blast radius is unguessable from the request — and writes only after it.",
  retract:
    "Previews what the retraction clears, then returns the coordinate to third-party polling."
} as const;

function ProducerRowView({
  row,
  now,
  onRetract
}: {
  row: DependencyLineProducerView;
  now: number;
  onRetract: () => void;
}): React.JSX.Element {
  return (
    <TableRow data-testid="producer-row" data-ecosystem={row.ecosystem}>
      <TableCell>
        <Badge variant="neutral" data-testid="producer-ecosystem">
          {row.ecosystem}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-900" data-testid="producer-coordinate">
        {row.coordinate}
      </TableCell>
      <TableCell data-testid="producer-component">
        <Link
          to="/components/$idOrUrn/dependencies"
          params={{ idOrUrn: row.producerObjectId }}
          className={cn("rounded text-sm text-slate-900 underline", focusRing)}
          data-testid="producer-link"
        >
          {row.producer.name !== "" ? (
            row.producer.name
          ) : (
            <span className="font-mono text-xs">{row.producerObjectId}</span>
          )}
        </Link>
        {row.producer.name === "" ? (
          <>
            {" "}
            <Badge
              variant="unknown"
              icon={CircleHelp}
              title="No component with this id resolves in this org (the server sends an empty name for a dangling reference — the object was deleted or never existed here); the id is shown instead."
              data-testid="producer-unnamed"
            >
              unnamed
            </Badge>
          </>
        ) : null}
      </TableCell>
      <TableCell className="text-xs text-slate-600">
        <span title={row.declaredAt} data-testid="producer-declared">
          {formatRelative(row.declaredAt, now)}
        </span>
      </TableCell>
      <TableCell className="text-xs text-slate-600" data-testid="producer-declared-by">
        {row.declaredBy.name !== "" ? (
          row.declaredBy.name
        ) : (
          <>
            {/* The SAME honesty signal the producer cell carries — one row, one rule: an empty
                name is the server saying the id resolves to no object here, and both cells say so
                the same way rather than one flagging it and the other printing a bare id. */}
            <span className="font-mono">{row.declaredByObjectId}</span>{" "}
            <Badge
              variant="unknown"
              icon={CircleHelp}
              title="No principal with this id resolves in this org (the server sends an empty name for a dangling reference — the object was deleted or never existed here); the id is shown instead."
              data-testid="producer-declarer-unnamed"
            >
              unnamed
            </Badge>
          </>
        )}
      </TableCell>
      <TableCell>
        <Button variant="outline" size="sm" onClick={onRetract} data-testid="producer-retract">
          Retract…
        </Button>
      </TableCell>
    </TableRow>
  );
}

/**
 * The page's whole rendering off an already-loaded, `managedHere: true` list. `producers` is the
 * unpaged org list; the ecosystem chips filter it client-side. Provider-free apart from the two
 * verb callbacks and the components read the declare dialog's picker needs.
 */
export function ProducersView({
  producers,
  components,
  componentsLoadMore,
  declare,
  retract,
  onDeclared,
  onRetracted,
  lastSuccess,
  now = Date.now()
}: {
  producers: readonly DependencyLineProducerView[];
  components: ComponentsRead;
  componentsLoadMore: ComponentsLoadMore;
  declare: (
    req: DeclareDependencyLineProducerRequest
  ) => Promise<DependencyLineProducerVerbResponse>;
  retract: (
    req: RetractDependencyLineProducerRequest
  ) => Promise<DependencyLineProducerVerbResponse>;
  onDeclared: (response: DependencyLineProducerVerbResponse) => void;
  onRetracted: (response: DependencyLineProducerVerbResponse) => void;
  lastSuccess: { message: string; decisionId: string | null } | null;
  now?: number;
}): React.JSX.Element {
  const [filter, setFilter] = useState<DependencyEcosystem | null>(null);
  const [declareOpen, setDeclareOpen] = useState(false);
  const [retracting, setRetracting] = useState<DependencyLineProducerView | null>(null);

  const present = ECOSYSTEMS.filter((eco) => producers.some((p) => p.ecosystem === eco));
  const shown = filter ? producers.filter((p) => p.ecosystem === filter) : producers;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Dependency producers"
        description="which components this org publishes which coordinates from"
        actions={
          <Button onClick={() => setDeclareOpen(true)} data-testid="declare-open">
            Declare…
          </Button>
        }
      />

      <p className="text-xs text-slate-500" data-testid="enablement-pointer">
        Dependency subscriptions are enabled per component — see a component's Dependencies tab; the
        instance unlock is operator-only:{" "}
        <code className="font-mono">scp dependency-subscriptions set-unlock --unlocked</code>.
      </p>

      {lastSuccess ? (
        <Notice tone="success" data-testid="producer-write-success">
          {lastSuccess.message}
          {lastSuccess.decisionId ? (
            <>
              {" "}
              <WhyLink decisionId={lastSuccess.decisionId} data-testid="producer-write-why" />{" "}
              <span className="font-mono text-xs" data-testid="producer-write-decision-id">
                {lastSuccess.decisionId}
              </span>
            </>
          ) : null}
        </Notice>
      ) : null}

      <Card size="compact">
        <CardHeader>
          <CardTitle>Producers</CardTitle>
          {present.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-testid="ecosystem-filter">
              {[null, ...present].map((eco) => (
                <button
                  key={eco ?? "all"}
                  type="button"
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs font-medium",
                    filter === eco
                      ? "border-army-700 bg-army-700 text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                    focusRing
                  )}
                  aria-pressed={filter === eco}
                  onClick={() => setFilter(eco)}
                  data-testid={`ecosystem-chip-${eco ?? "all"}`}
                >
                  {eco ?? "all"}
                </button>
              ))}
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          {producers.length === 0 ? (
            <EmptyState
              icon={Package}
              message={NO_PRODUCERS_SENTENCE}
              data-testid="producers-empty"
            />
          ) : shown.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="producers-filtered-empty">
              No {filter} producers — {producers.length} declared in other ecosystems.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ecosystem</TableHead>
                  <TableHead>Coordinate</TableHead>
                  <TableHead>Producer</TableHead>
                  <TableHead>Declared</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((row) => (
                  <ProducerRowView
                    key={`${row.ecosystem}\u0000${row.coordinate}`}
                    row={row}
                    now={now}
                    onRetract={() => setRetracting(row)}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={declareOpen} onOpenChange={(open) => !open && setDeclareOpen(false)}>
        <DialogContent data-testid="declare-dialog">
          <DialogHeader>
            <DialogTitle>Declare a producer</DialogTitle>
            <DialogDescription>{DIALOG_COPY.declare}</DialogDescription>
          </DialogHeader>
          {declareOpen ? (
            <DeclareDialogBody
              components={components}
              componentsLoadMore={componentsLoadMore}
              run={declare}
              onDeclared={(response) => {
                setDeclareOpen(false);
                onDeclared(response);
              }}
              onCancel={() => setDeclareOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={retracting !== null} onOpenChange={(open) => !open && setRetracting(null)}>
        <DialogContent data-testid="retract-dialog">
          <DialogHeader>
            <DialogTitle>Retract a producer declaration</DialogTitle>
            <DialogDescription>{DIALOG_COPY.retract}</DialogDescription>
          </DialogHeader>
          {retracting ? (
            <RetractDialogBody
              key={`${retracting.ecosystem}\u0000${retracting.coordinate}`}
              producer={retracting}
              run={retract}
              onRetracted={onRetracted}
              onClose={() => setRetracting(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** `/admin/dependencies` — the page: the role gate, the one list read, the components read the
 *  picker needs, and the two verbs threaded into the provider-free view. */
export function AdminDependenciesPage(): React.JSX.Element {
  const { user } = useAuth();
  const instanceRole = user?.instanceRole;
  const queryClient = useQueryClient();
  const [lastSuccess, setLastSuccess] = useState<{
    message: string;
    decisionId: string | null;
  } | null>(null);

  const isCommander = instanceRole === "commander";
  const listQuery = useQuery({
    queryKey: dependencyProducersKey(),
    queryFn: () => client.dependencyProducers.list(),
    enabled: isCommander
  });
  // The picker's list — read only once the page is a real, managed-here commander page (the gate
  // below has let the list through), and only then: no read of any kind leaves a non-commander site.
  const managedHere = listQuery.data?.dependencyManagement.managedHere === true;
  // `limit: 100` is ObjectListQuerySchema's MAX (packages/schemas/src/graph.ts) — a larger value is a
  // 400 before auth, which is what every other components.list call site in this app also respects.
  // The first page loads eagerly; an org with more than 100 components gets a "Load more" affordance
  // (`ComponentsLoadMore`) that fetches subsequent pages via the SERVER's own `nextCursor` — never a
  // client-guessed offset, and `useInfiniteQuery` guarantees at most one page in flight at a time.
  const componentsQuery = useInfiniteQuery({
    queryKey: ["components", "picker", { limit: 100 }],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      client.components.list({ limit: 100, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: isCommander && managedHere
  });

  // Commander-only feature (owner rule 2026-08-17): any other install-time role gets the pointer,
  // whatever the reads would have said. Read from `instanceRole`, never inferred from data.
  if (!isCommander) return <ManagedAtCommanderNotice role={instanceRole} />;
  if (listQuery.isLoading)
    return <Skeleton className="h-24 w-full" data-testid="producers-pending" />;
  if (listQuery.error) {
    return (
      <QueryErrorNotice
        error={listQuery.error}
        what="the org's dependency producer declarations"
        testId="producers-error"
      />
    );
  }
  const data = listQuery.data;
  if (!data) return <Skeleton className="h-24 w-full" data-testid="producers-pending" />;
  // THE SERVER IS THE AUTHORITY (ADR-0032 §7d): when it says dependencies are not managed here, the
  // rest of the envelope is not interpreted — the same pointer, with the server's stated reason.
  if (data.dependencyManagement.managedHere === false) {
    return <ManagedAtCommanderNotice reason={data.dependencyManagement.reason} />;
  }

  const components: ComponentsRead = componentsQuery.error
    ? { status: "error", error: componentsQuery.error }
    : componentsQuery.data
      ? { status: "ok", data: componentsQuery.data.pages.flatMap((page) => page.items) }
      : { status: "pending" };
  const componentsLoadMore: ComponentsLoadMore = {
    hasMore: componentsQuery.hasNextPage === true,
    loading: componentsQuery.isFetchingNextPage,
    onLoadMore: () => void componentsQuery.fetchNextPage()
  };

  const refresh = () => void queryClient.invalidateQueries({ queryKey: dependencyProducersKey() });

  return (
    <ProducersView
      producers={data.producers}
      components={components}
      componentsLoadMore={componentsLoadMore}
      declare={(req) => client.dependencyProducers.declare(req)}
      retract={(req) => client.dependencyProducers.retract(req)}
      onDeclared={(response) => {
        const who = response.declaration?.producer.name || response.declaration?.producerObjectId;
        setLastSuccess({
          message: `Declared ${response.ecosystem} ${response.coordinate} → ${who ?? "the producer"} — the list below is re-read from the server.`,
          decisionId: response.decisionId
        });
        refresh();
      }}
      onRetracted={() => {
        setLastSuccess(null);
        refresh();
      }}
      lastSuccess={lastSuccess}
    />
  );
}
