#!/usr/bin/env python3
"""Convert tenant parameters (JSON) into an Ansible vars file where NOTHING is Jinja2.

M27.2 / ADR-0002's "tenant parameters are data-only, never rendered as Jinja2".

WHY THIS EXISTS AT THE BOUNDARY. Ansible templates variable values wherever they are used, so a
tenant parameter containing `{{ lookup('pipe', 'id') }}` is evaluated — executing a command — the
moment any role references it. That is SSTI -> RCE, and it does not require the role to do anything
careless: `debug: msg="{{ pkg }}"` is enough.

The defence cannot be "roles must remember to mark things unsafe", because that is a property every
future role author has to re-derive correctly. It is applied HERE, once, where tenant data crosses
into the run: every string is emitted with YAML's `!unsafe` tag, which Ansible honours by wrapping
the value so the templar returns it verbatim instead of rendering it.

Applied RECURSIVELY — a payload nested inside a list inside a dict is still tenant data, and the
obvious implementation that only walks top-level keys is a hole big enough to drive a lookup
through.

Keys are marked too, not just values. A key is far less likely to be rendered, but `with_dict` and
friends expose keys as `item.key`, and a rule with an exception is a rule someone has to remember.
"""
import json
import sys

import yaml


class Unsafe(str):
    """A string that must reach Ansible tagged `!unsafe`."""


def _represent_unsafe(dumper: yaml.Dumper, data: Unsafe) -> yaml.ScalarNode:
    return dumper.represent_scalar("!unsafe", str(data))


yaml.add_representer(Unsafe, _represent_unsafe)


def harden(value):
    """Recursively mark every string — at any depth, in keys and values alike."""
    if isinstance(value, str):
        return Unsafe(value)
    if isinstance(value, list):
        return [harden(v) for v in value]
    if isinstance(value, dict):
        return {harden(k): harden(v) for k, v in value.items()}
    # bool/int/float/None carry no template. Deliberately NOT stringified: coercing them would
    # change a role's type expectations to close a hole that is not open.
    return value


def main() -> int:
    raw = json.load(open(sys.argv[1]))
    if not isinstance(raw, dict):
        print("params_to_vars: parameters must be a JSON object", file=sys.stderr)
        return 2
    # Reserved-name guard: a tenant parameter named `ansible_connection`, `ansible_python_interpreter`
    # or similar would reconfigure the RUN rather than feed it. Marking it unsafe does not help —
    # the danger is that it is honoured at all, so these are refused outright.
    for key in raw:
        if not isinstance(key, str) or key.startswith("ansible_"):
            print(f"params_to_vars: refusing reserved parameter name {key!r}", file=sys.stderr)
            return 2
    yaml.dump(harden(raw), sys.stdout, default_flow_style=False, allow_unicode=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
