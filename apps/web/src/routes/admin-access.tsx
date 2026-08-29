import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, UserCog } from "lucide-react";
import type { Role, RoleBinding } from "@scp/schemas";
import { client } from "../lib/client";
import { useAuth } from "../lib/auth-context";
import { authzEffectiveKey, roleBindingsKey, rolesKey } from "../lib/query-client";
import { Alert } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
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

/**
 * ADMIN › ACCESS — roles, role bindings, and "what may I do here"
 * (docs/proposals/role-model.md §5 steps 5, 6, 10; server routes
 * `apps/server/src/routes/role-bindings.ts` and `routes/authz.ts`; SDK facades `client.roles`,
 * `client.roleBindings`, `client.authz`).
 *
 * ================================================================================================
 * WHY THIS PAGE EXISTS AT ALL, AND WHY IT IS NOT A PERMISSION MATRIX
 * ================================================================================================
 * The cumulative ladder was guessable — Viewer < Operator < Approver < Administrator < Owner — so a
 * UI could infer a principal's whole permission set from a rank. drizzle/0099's five purpose roles
 * are deliberately NOT ordered: SecurityOfficer holds `scan:override` and no `object:write`;
 * OrgAdmin holds `policy:write` and NOT `scan:override`; neither is above the other. There is
 * nothing left to infer, which is why step 6 built `GET /authz/effective` and why this page asks
 * the server rather than computing anything client-side.
 *
 * ================================================================================================
 * THE OFFER-THE-WRITE RULE (M16.3), APPLIED
 * ================================================================================================
 * Every write here renders for every viewer, and the SERVER'S OWN REFUSAL SENTENCE is what tells
 * them no. This page never hides a button behind a client-side permission guess — a guess that is
 * wrong in the permissive direction is a phantom control, and one wrong in the restrictive
 * direction hides a capability the viewer actually has. The refusals this API produces are written
 * to be read (they name the missing permission and the scope), so showing them is better than
 * pre-empting them.
 *
 * ONE DELIBERATE EXCEPTION, and it is the same one Admin › Governance makes: instance-tier
 * OPERATOR CREDENTIALS are not offered here. Their write is gated by `x-scp-operator-token`, a
 * deployment credential this browser never holds and should never be asked to hold. The section
 * names the CLI verb instead of rendering a form that could only ever 403.
 */
export function AdminAccessPage(): JSX.Element {
  const auth = useAuth();
  // `/auth/me`'s orgId IS the org root object id (ADR-0021 D4), which is the scope a viewer most
  // often wants to ask about first.
  const orgId = auth.user?.orgId ?? "";

  const roles = useQuery({
    queryKey: rolesKey(),
    queryFn: () => client.roles.list()
  });
  const bindings = useQuery({
    queryKey: roleBindingsKey(),
    queryFn: () => client.roleBindings.list()
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Access"
        description="Roles, who holds them, and what that means at a given object."
      />

      <RolesSection roles={roles} />
      <BindingsSection bindings={bindings} />
      <EffectiveSection defaultScope={orgId} />
      <OperatorCredentialsSection />
    </div>
  );
}

function RolesSection({
  roles
}: {
  roles: ReturnType<typeof useQuery<{ items: Role[] }>>;
}): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Roles</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Built-in roles are shared by every organization on this deployment and cannot be edited
          here — narrowing one would narrow it for everyone. Roles your organization defines are
          yours to change.
        </p>
        {roles.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : roles.isError ? (
          <QueryErrorNotice error={roles.error} what="the role catalogue" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Bindable at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.data.items.map((role) => (
                <TableRow key={role.id}>
                  <TableCell className="font-medium">
                    {role.name}
                    {role.deprecated ? (
                      // D5: the role still resolves for EXISTING bindings and accepts no new ones.
                      // "Deprecated" alone reads as inert, which would be wrong and alarming.
                      <Badge variant="warning" className="ml-2">
                        no new bindings
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={role.orgId === null ? "neutral" : "info"}>
                      {role.orgId === null ? "built-in" : "organization"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {role.permissions.length === 0 ? "—" : [...role.permissions].sort().join(" ")}
                  </TableCell>
                  <TableCell className="text-xs">
                    {role.bindableAt === null ? "any scope" : role.bindableAt.join(", ")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {roles.data && roles.data.items.some((r) => r.deprecationReason) ? (
          <Alert tone="info">
            {roles.data.items.find((r) => r.deprecationReason)?.deprecationReason}
          </Alert>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Authoring a role: <code>scp role create --name … --permission … --reason …</code>. A role
          may only carry permissions you hold yourself — otherwise this catalogue would advertise
          authority its author cannot confer.
        </p>
      </CardContent>
    </Card>
  );
}

function BindingsSection({
  bindings
}: {
  bindings: ReturnType<typeof useQuery<{ items: RoleBinding[] }>>;
}): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Who holds what</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Bindings written <em>at</em> an object. A binding reaches everything beneath its scope, so
          this list is not "who can act on X" — that question is answered below.
        </p>
        {bindings.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : bindings.isError ? (
          // `audit:read` gates this list; a viewer without it sees the server's sentence rather
          // than an empty table that would read as "nobody holds anything".
          <QueryErrorNotice error={bindings.error} what="role bindings" />
        ) : bindings.data.items.length === 0 ? (
          <EmptyState
            icon={UserCog}
            message="Nobody holds a role at any scope in this organization."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Effect</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.data.items.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.roleName}</TableCell>
                  <TableCell className="font-mono text-xs">{b.subjectId}</TableCell>
                  <TableCell className="font-mono text-xs">{b.scopeObjectId}</TableCell>
                  <TableCell>
                    {/* A deny overrides every allow at any matching scope, so it must never be a
                        footnote — it is rendered as the loudest thing in the row. */}
                    <Badge variant={b.effect === "deny" ? "danger" : "neutral"}>{b.effect}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">
          Granting: <code>scp role-binding grant-preview &lt;subjectId&gt;</code> then{" "}
          <code>scp role-binding create …</code>. The preview is not ceremony — for a group it names
          every principal the binding would empower, and whether an identity provider owns that
          membership.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * "What may I do here" — `GET /authz/effective`, which answers about the CALLER and nobody else.
 *
 * There is no subject picker on purpose. The endpoint takes no `subjectId`, because a
 * caller-chosen authorization anchor is one the caller sets to whatever admits them — the defect
 * the neighbouring grant-preview was rewritten twice to remove. "Who else has authority here" is a
 * real question and a different one.
 */
function EffectiveSection({ defaultScope }: { defaultScope: string }): JSX.Element {
  const [scope, setScope] = useState(defaultScope);
  const [submitted, setSubmitted] = useState(defaultScope);

  const effective = useQuery({
    queryKey: authzEffectiveKey(submitted),
    queryFn: () => client.authz.effective(submitted),
    enabled: submitted.length > 0
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>What may I do here</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Your own permissions at one object, with the bindings that produced them. Answers about
          you and nobody else.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(scope.trim());
          }}
        >
          <Input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="object id"
            aria-label="Object id"
            className="font-mono"
          />
          <Button type="submit">Check</Button>
        </form>

        {submitted.length === 0 ? null : effective.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : effective.isError ? (
          <Alert tone="danger">{queryErrorMessage(effective.error)}</Alert>
        ) : (
          <div className="space-y-3">
            <div>
              <SectionLabel>Permissions</SectionLabel>
              {effective.data.permissions.length === 0 ? (
                // "You hold nothing here" and "we could not ask" are different facts, and the
                // endpoint distinguishes them (200 vs 404) precisely so this can too.
                <p className="text-sm text-muted-foreground">
                  You hold no permissions at this object.
                </p>
              ) : (
                <p className="font-mono text-xs">{effective.data.permissions.join(" ")}</p>
              )}
            </div>
            <div>
              <SectionLabel>Why</SectionLabel>
              {effective.data.contributingBindings.length === 0 ? (
                <p className="text-sm text-muted-foreground">No binding reaches this object.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Role</TableHead>
                      <TableHead>Bound at</TableHead>
                      <TableHead>Via</TableHead>
                      <TableHead>Effect</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {effective.data.contributingBindings.map((b, i) => (
                      <TableRow key={`${b.roleId}-${b.scopeObjectId}-${i}`}>
                        <TableCell className="font-medium">{b.roleName}</TableCell>
                        <TableCell className="font-mono text-xs">{b.scopeObjectId}</TableCell>
                        {/* Naming the subject is how somebody answers "why do I have this?" —
                            it is either them or a group they belong to. */}
                        <TableCell className="font-mono text-xs">{b.viaSubjectId}</TableCell>
                        <TableCell>
                          <Badge variant={b.effect === "deny" ? "danger" : "neutral"}>
                            {b.effect}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * READ-NOTHING, OFFER-NOTHING — deliberately, and the same call Admin › Governance makes for the
 * instance rung.
 *
 * Every operator-credential verb is gated by `x-scp-operator-token`: a deployment credential this
 * browser never holds and should not be taught to. Rendering a form here could only ever produce a
 * 403, and rendering a LISTING would require sending that token from a browser — so the section
 * names the CLI instead. Present rather than omitted, because an operator looking for this surface
 * should find out where it lives rather than conclude it does not exist.
 */
function OperatorCredentialsSection(): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Operator credentials</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Alert tone="info">
          Instance-tier credentials are managed from the CLI, not here. They authorize writes that
          bind every organization on this deployment, so they are gated by a deployment credential (
          <code>x-scp-operator-token</code>) that this browser never holds.
        </Alert>
        <pre className="rounded bg-muted p-3 text-xs">
          <code>
            {"scp operator-credential list\n"}
            {"scp operator-credential create --name <label>\n"}
            {"scp operator-credential revoke <id>"}
          </code>
        </pre>
        <p className="text-xs text-muted-foreground">
          <KeyRound className="mr-1 inline h-3 w-3" aria-hidden />
          If <code>list</code> reports the caller was admitted by the bootstrap env token, this
          deployment is still relying on <code>SCP_OPERATOR_TOKEN</code>: mint a credential and
          unset it.
        </p>
      </CardContent>
    </Card>
  );
}
