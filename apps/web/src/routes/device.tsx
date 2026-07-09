import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { client } from "../lib/client";
import { useUserCodeSearch } from "../lib/use-route-params";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";

/**
 * `/device` (BUILD_AND_TEST.md §8 M2 item 2) — browser approval page for the CLI's device-
 * authorization flow (routes/device-flow.ts `POST /auth/device/approve`). `?user_code=` pre-fills
 * the field; the full CLI polling round-trip is covered by stage 2's server-side integration test
 * (auth/device-flow.ts) — this page just needs to render and submit correctly.
 */
export function DevicePage(): React.JSX.Element {
  const initialCode = useUserCodeSearch();
  const [userCode, setUserCode] = useState(initialCode ?? "");

  const approveMutation = useMutation({
    mutationFn: (code: string) => client.deviceFlow.approve(code)
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!userCode.trim()) return;
    approveMutation.mutate(userCode.trim());
  }

  return (
    <div className="mx-auto max-w-sm">
      <Card>
        <CardHeader>
          <CardTitle>Approve device sign-in</CardTitle>
          <CardDescription>
            Confirm the code shown on your other device to sign it in as you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="user-code" className="text-sm font-medium text-slate-700">
                Device code
              </label>
              <Input
                id="user-code"
                value={userCode}
                onChange={(e) => setUserCode(e.target.value)}
                placeholder="XXXX-XXXX"
                data-testid="device-code-input"
                required
              />
            </div>
            <Button type="submit" disabled={approveMutation.isPending}>
              {approveMutation.isPending ? "Approving…" : "Approve"}
            </Button>
          </form>
          {approveMutation.isSuccess && (
            <p className="mt-4 text-sm text-green-700" data-testid="device-approve-success">
              Approved — you can return to the other device.
            </p>
          )}
          {approveMutation.isError && (
            <p className="mt-4 text-sm text-red-600" data-testid="device-approve-error">
              {approveMutation.error instanceof Error
                ? approveMutation.error.message
                : "Approval failed — the code may be invalid or expired."}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
