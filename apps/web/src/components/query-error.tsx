import type { ResponseValidationIssue } from "@scp/sdk";
import { Alert } from "./ui/alert";

/** THE HUMAN END OF THE SDK RESPONSE-VALIDATION BOUNDARY. See docs/web.md §102. */

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
  // Rendered through the shared Alert (design spec §2.3); the diagnosis content, the testids and
  // the `data-error-kind` attribute are the pinned behaviour and stay exactly as they were.
  return (
    <Alert
      tone="danger"
      role="alert"
      data-testid={testId ?? "query-error"}
      data-error-kind={isContract ? "contract" : "request"}
      title={<>Could not load {what}.</>}
    >
      {isContract && (
        <p className="mt-1" data-testid="query-error-contract">
          This instance answered <code className="break-words font-mono">{error.operation}</code>{" "}
          with a body that does not match the API contract this UI was built from — most likely a
          version skew between this UI and the instance. Nothing below is a network or permission
          failure.
        </p>
      )}
      <p className="mt-1 break-words font-mono text-xs" data-testid="query-error-detail">
        {queryErrorMessage(error)}
      </p>
      {isContract && error.issues.length > 0 && (
        <ul
          className="mt-1 list-disc break-words pl-5 font-mono text-xs"
          data-testid="query-error-fields"
        >
          {error.issues.map((issue) => (
            <li key={`${issue.path}:${issue.code ?? ""}:${issue.message}`}>
              {issue.path} — {issue.code ?? "invalid"}: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}
