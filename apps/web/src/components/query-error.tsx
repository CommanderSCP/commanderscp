import type { ResponseValidationIssue } from "@scp/sdk";

/**
 * THE HUMAN END OF THE SDK RESPONSE-VALIDATION BOUNDARY (ADR-0023).
 *
 * Validation makes a contract failure LOUD and SINGLE — it converts a body that does not match the
 * OpenAPI contract into one `ScpResponseValidationError` naming the operation and the offending
 * field, instead of a `TypeError` thrown from whichever component happened to dereference the
 * missing key first. That is only half of a fix. In this SPA every read goes through TanStack Query,
 * and a rejected `queryFn` becomes `query.isError` — a STATE. A page that renders only `isLoading`
 * and `data` renders NOTHING for that state, so the diagnosis the boundary just produced dies in
 * the query cache and the operator sees an empty card. This module is the other half: it puts the
 * diagnosis on the screen.
 *
 * WHAT IT MUST SAY, and why a fixed string is not enough. "Could not load federation status." is
 * indistinguishable across a 401, an unreachable instance, and a version skew — three faults with
 * three different remedies. The one thing the boundary exists to produce is the operation plus the
 * offending field(s), so that is what gets rendered: verbatim `error.message`, plus an explicit
 * "contract" heading and the field list when the failure is a validation failure. An operator can
 * read `peers.0.recentTransfers` off the screen and take it to an upgrade.
 */

/** The subset of `ScpResponseValidationError` this module reads. Matched STRUCTURALLY rather than
 *  with `instanceof`: an error crosses a package boundary (and, in tests, a module mock) to get
 *  here, and a duplicated class identity must not silently downgrade the rendering to the generic
 *  branch. `name` is set explicitly by the SDK's constructor. */
interface ValidationErrorLike {
  readonly name: string;
  readonly message: string;
  readonly operation: string;
  readonly issues: readonly ResponseValidationIssue[];
}

export function isResponseValidationError(error: unknown): error is ValidationErrorLike {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Partial<ValidationErrorLike>;
  return (
    candidate.name === "ScpResponseValidationError" &&
    typeof candidate.operation === "string" &&
    Array.isArray(candidate.issues)
  );
}

/** The message to show. Never a fixed string: `Error.message` is where the SDK put the operation,
 *  the status, and the failing fields, and an RFC 9457 problem's detail lands there too. */
export function queryErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return String(error);
}

/**
 * The rendered form of a failed read. `what` names the thing that could not be loaded ("federation
 * status") so the notice reads as a sentence; the diagnosis follows it, never replaces it.
 */
export function QueryErrorNotice({
  error,
  what,
  testId
}: {
  error: unknown;
  what: string;
  testId?: string;
}): React.JSX.Element {
  const isContract = isResponseValidationError(error);
  return (
    <div
      role="alert"
      data-testid={testId ?? "query-error"}
      data-error-kind={isContract ? "contract" : "request"}
      className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
    >
      <p className="font-medium">Could not load {what}.</p>
      {isContract && (
        <p className="mt-1" data-testid="query-error-contract">
          This instance answered <code className="font-mono">{error.operation}</code> with a body
          that does not match the API contract this UI was built from — most likely a version skew
          between this UI and the instance. Nothing below is a network or permission failure.
        </p>
      )}
      <p className="mt-1 break-words font-mono text-xs" data-testid="query-error-detail">
        {queryErrorMessage(error)}
      </p>
      {isContract && error.issues.length > 0 && (
        <ul className="mt-1 list-disc pl-5 font-mono text-xs" data-testid="query-error-fields">
          {error.issues.map((issue) => (
            <li key={`${issue.path}:${issue.code ?? ""}:${issue.message}`}>
              {issue.path} — {issue.code ?? "invalid"}: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
