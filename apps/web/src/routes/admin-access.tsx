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

/** ADMIN › ACCESS. See docs/web.md §162. */
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

/** "What may I do here". See docs/web.md §163. */
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

/** Read nothing, offer nothing, and the same call elsewhere. See docs/web.md §164. */
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
