import { useState, type FormEvent } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../ui/dialog";
import { WhyLink } from "./WhyLink";

/** The shared shell for every reason-carrying transition dialog. See docs/web.md §34. */
export function ReasonDialog({
  open,
  title,
  description,
  reasonRequired,
  pending,
  errorMessage,
  errorDecisionId,
  onOpenChange,
  onSubmit,
  submitLabel,
  testIdPrefix
}: {
  open: boolean;
  title: string;
  description: string;
  reasonRequired: boolean;
  pending: boolean;
  errorMessage: string | null;
  errorDecisionId?: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string) => void;
  submitLabel: string;
  testIdPrefix: string;
}): React.JSX.Element {
  const [reason, setReason] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = reason.trim();
    if (reasonRequired && !trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason("");
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`${testIdPrefix}-reason`}
              className="text-sm font-medium text-slate-700"
            >
              Reason{reasonRequired ? "" : " (optional)"}
            </label>
            <Input
              id={`${testIdPrefix}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={reasonRequired}
              data-testid={`${testIdPrefix}-reason-input`}
            />
          </div>
          {errorMessage && (
            <p className="text-sm text-red-600">
              {errorMessage}
              {errorDecisionId && (
                <>
                  {" "}
                  <WhyLink decisionId={errorDecisionId} />
                </>
              )}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || (reasonRequired && reason.trim().length === 0)}
              data-testid={`${testIdPrefix}-submit`}
            >
              {pending ? "Submitting…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
