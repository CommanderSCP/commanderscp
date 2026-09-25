# CommanderSCP

CommanderSCP is a **Federated Systems Coordination Platform**: a graph-native system of record that
models an organization's systems, ownership, dependencies and governance, and coordinates change
across the execution systems you already run (Argo CD, Argo Workflows, GitHub, Terraform/OpenTofu,
…). It **coordinates rather than executes** — it never holds credentials to the infrastructure those
systems manage — with one exception, a small managed-execution mode for trivial IaC releases. It
operates the same way across connected, disconnected and air-gapped domains.

See [PROJECT_CHARTER.md](PROJECT_CHARTER.md) for the full vision and non-negotiable principles, and
[docs/GLOSSARY.md](docs/GLOSSARY.md) for vocabulary (promotion, accept, domain, stage/wave).

## Install

One command, any role, any substrate: `scp install`. It installs CommanderSCP, turns on the
[Standard Stack](docs/adr/0058-stack-controller.md) (Argo CD, Argo Workflows, Argo Rollouts, Argo
Events, Gitea — the execution systems CommanderSCP bundles and operates for you), reaches a
logged-in admin session, and — for a commander — declares the HQ outpost. Nothing else to do first.

| You are installing…                                    | Run                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| A **commander**, connected to a Kubernetes cluster     | `scp install --role commander --profile eval --kube-context <your-context>`                                         |
| A **field outpost**, connected to a Kubernetes cluster | `scp install --role outpost --profile eval --kube-context <your-context>`                                           |
| A **retrans** relay (CDS-boundary; no Standard Stack)  | `scp install --role retrans --profile production --kube-context <your-context>`                                     |
| A VM, no Kubernetes                                    | `scp install --role commander --profile eval --mode compose`                                                        |
| An air-gapped bundle                                   | `scp install --role commander --bundle <extracted-bundle-dir> --registry <your-registry> --pubkey <path-to-pubkey>` |

No cluster yet? Add `--bootstrap-k3s` to install a single-node k3s first (connected installs only —
see `scp install --help` and [docs/adr/0060-front-door.md](docs/adr/0060-front-door.md) for the
air-gapped exception). `--profile production` for a real deployment; `eval` is for trying it out (an
in-cluster Postgres, demo-friendly defaults). Every backend the role doesn't default to is a flag
away: `--with <backend>` / `--without <backend>` (repeatable), or answer the interactive checklist.

`scp install` prints the bootstrap admin's one-time password **in its own terminal** — never a pod
log — logs in with it, and stores the session. See [docs/quickstart.md](docs/quickstart.md) for a
full walkthrough, including what each substrate needs first.

## First login

`scp install` already logged you in — `scp whoami` confirms it. From another machine, or later:

```
scp login --base-url <your-instance's-api-url>
```

## First service

```
scp service register --name <your-service-name>
```

Then open the web UI. An org with nothing configured yet lands on the setup checklist — connect a
source (GitHub, GitLab, or the bundled Gitea), register a service from a repo, name your
environments.

## Learn more

| Document                                         | Role                                                           |
| ------------------------------------------------ | -------------------------------------------------------------- |
| [docs/quickstart.md](docs/quickstart.md)         | Full install walkthrough, per role and substrate               |
| [PROJECT_CHARTER.md](PROJECT_CHARTER.md)         | **Authoritative.** Vision, requirements, principles, MVP scope |
| [docs/DESIGN.md](docs/DESIGN.md)                 | Architecture                                                   |
| [docs/BUILD_AND_TEST.md](docs/BUILD_AND_TEST.md) | Toolchain, bootstrap, test strategy, milestones                |
| [docs/GLOSSARY.md](docs/GLOSSARY.md)             | **Authoritative for vocabulary**                               |
| [docs/adr/](docs/adr/)                           | Architecture decision records                                  |
