# Quickstart

One command installs CommanderSCP — the platform, the [Standard Stack](adr/0058-stack-controller.md)
it operates for you (Argo CD, Argo Workflows, Argo Rollouts, Argo Events, Gitea), a logged-in admin
session, and — for a commander — the HQ outpost. This walks through each substrate. See
`scp install --help` for every flag; only flags that exist are documented here or in the root
[README.md](../README.md).

## Prerequisites

- The `scp` CLI (`packages/cli`) — built from this repo (`pnpm build`), or your distribution's
  package. This document assumes `scp` is on your `PATH`; if it isn't, run it as
  `node packages/cli/dist/bin.js …` from a checkout.
- One of: a reachable Kubernetes context (`kubectl config get-contexts`), a VM with Docker (VM/
  compose mode), or an air-gapped signed bundle (`docs/OFFLINE_INSTALL.md`).
- `helm`, `kubectl` on `PATH` for a Kubernetes install; `docker` (with the compose plugin) for a VM
  install. No cluster yet? `--bootstrap-k3s` (see "No cluster yet?" below).

## Connected, Kubernetes — commander

```
scp install --role commander --profile eval --kube-context <your-context>
```

What this does, in order: installs the chart (turning on the stack controller and the commander's
default backends — Argo CD, Argo Workflows, Argo Rollouts, Argo Events, Gitea), reads the
bootstrap admin's one-time password (printed **in this terminal**, never in a pod log — see
[docs/adr/0060-front-door.md](adr/0060-front-door.md)), logs in with it and stores the session,
declares this instance's federation identity, enables the role's Standard Stack backends and waits
for each to report ready or what it still needs, and declares the HQ outpost.

You'll see a summary like:

```
bootstrap admin one-time password (shown once — not stored in plaintext): <password>
Logged in as 'admin' (org: default). Token stored.
declaring this instance's federation identity (role: commander)...
enabling stack backend: argocd
...
BACKEND         ENABLED  SIZE   PHASE  RUNNING  TARGET  NEEDS  ERROR
argocd          yes      small  ready  1.0.0    1.0.0   -      -
...
HQ outpost declared.

Install complete. API base URL: http://127.0.0.1:<port>/api/v1
  scp whoami        (confirm the session)
  scp stack status  (backend health)
```

Confirm: `scp whoami`. A backend that reports `needs` instead of `ready` is telling you what it
still requires (for example a build image or an infra state backend) — `scp stack status` shows the
detail; it is not an install failure.

## Connected, Kubernetes — field outpost

```
scp install --role outpost --profile eval --kube-context <your-context>
```

An outpost's default stack is Argo CD, Argo Rollouts and Gitea (deploy-side only — proposal §5). Add
`--with argo-workflows` if this outpost builds or plans locally.

## Retrans (CDS-boundary relay)

```
scp install --role retrans --profile production --kube-context <your-context>
```

A relay validates and forwards; it runs no Standard Stack backend at all (the stack controller is
not even turned on for this role).

## VM, no Kubernetes (compose)

```
scp install --role commander --profile eval --mode compose
```

Installs SCP itself (and Gitea, if enabled) via `docker compose`. The Argo family needs Kubernetes
(there is nothing to run it on), so this mode does not install it — re-run with `--mode kube`
against a cluster (or `--bootstrap-k3s`, below) once you have one.

## Air-gapped bundle

```
scp install --role commander --bundle <extracted-bundle-dir> --registry <your-registry.example.com/scp> --pubkey <path-to-external-cosign-pubkey>
```

Wraps the signed bundle's own `install.sh`: every image is cosign-verified against your **external**
public key (never the key shipped inside the bundle — see `install.sh --help`'s security model),
pushed to your registry, and pinned by digest before anything is deployed. `--mode compose` works
here too, for an air-gapped VM. See `docs/OFFLINE_INSTALL.md` for how bundles are built and signed.

## No cluster yet?

```
scp install --role commander --profile eval --bootstrap-k3s
```

Installs a single-node k3s first (`curl https://get.k3s.io | sh -` — a network fetch, so this is for
a **connected** install only; an air-gapped install with no cluster is refused with what to run
instead — see [docs/adr/0060-front-door.md](adr/0060-front-door.md)).

## Choosing which backends install

Every role has a default (the table in the root README's "Install" section links to
`docs/proposals/zero-to-running.md` §5). To change it non-interactively:

```
scp install --role commander --with argo-workflows --without gitea --yes
```

Without `--yes`, and with a terminal attached, `scp install` asks about each backend interactively
(Enter keeps the role's default).

## First login (again, or from elsewhere)

`scp install` already logged you in. From another machine, or after your session expires:

```
scp login --base-url <your-instance's-api-url>
scp whoami
```

## First service

```
scp service register --name <your-service-name>
```

Or open the web UI: an org with nothing configured yet lands on the setup checklist instead of the
dashboard — connect a source (GitHub, GitLab, or the bundled Gitea), register a service from a repo,
and name your environments.

## Pointing `scp` at an already-installed instance

If you didn't just run `scp install` (or its port-forward has since closed and no ingress is
configured), reach the API directly:

```
kubectl -n <namespace> port-forward svc/<release>-commanderscp-api 8080:80
scp login --base-url http://127.0.0.1:8080/api/v1
```

A production install should set `ingress.enabled=true` (see `deploy/helm/README.md`) so this step
isn't needed day to day.
