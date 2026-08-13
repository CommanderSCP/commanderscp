import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { client } from "../lib/client";
import { useUserCodeSearch } from "../lib/use-route-params";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Notice } from "../components/ui/notice";

/**
 * `/device` (BUILD_AND_TEST.md §8 M2 item 2) — browser approval page for the CLI's device-
 * authorization flow (routes/device-flow.ts `POST /auth/device/approve`). `?user_code=` pre-fills
 * the field; the full CLI polling round-trip is covered by M2 step 2's server-side integration test
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
    // Same canvas + accent-edge card treatment as `/login` (spec §4E) — device approval is another
    // pre-auth-chrome page.
    <div className="flex min-h-screen items-center justify-center bg-army-50 p-4">
      <Card className="w-full max-w-sm border-t-2 border-t-army-700 shadow-sm">
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
            <Notice tone="success" className="mt-4" data-testid="device-approve-success">
              Approved — you can return to the other device.
            </Notice>
          )}
          {approveMutation.isError && (
            <Notice tone="danger" className="mt-4" data-testid="device-approve-error">
              {approveMutation.error instanceof Error
                ? approveMutation.error.message
                : "Approval failed — the code may be invalid or expired."}
            </Notice>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
