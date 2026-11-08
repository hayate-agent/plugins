# Agent registration

AgentHub owns the registered-agent inventory. It is usable through the dashboard
API or `/agent-hub` commands; it does not require a browser.

## Pair a Hayate target

1. Install credentials, workspace, AgentHub and AgentLink on the target. Enable
   its HTTPS AgentLink listener with a trusted certificate and explicit project
   access policy. The transport configuration is described in `docs/agent-link.md`.
2. On the target, run `/agent-hub pair`. The response contains its enabled endpoint
   and a five-minute, single-use registration code. Generating a code without an
   enabled target endpoint is refused.
3. In the dashboard, open **Agents → Register an agent**. Enter the target endpoint,
   code, display name and optional color. Use the pairing code, not a password.
4. Check the displayed target identity and permissions. **Check connection** sends
   only a scoped read request; it never creates work or replays a message.

The target stores token hashes. The registering instance holds its token in the
credential backend. Neither browser storage nor public agent metadata contains
that token. Codes are stored hashed and consumed atomically. Duplicate endpoint
registration is rejected before consuming a further code.

## Manage a registration

- Rename or recolor an agent without changing its identity, endpoint or credentials.
- Check connectivity; results record their observation time, not a permanent health guarantee.
- Remove an agent by revoking its target authorization first, then removing local credentials and metadata.
- If remote revocation fails, retain the registration for an explicit retry.
- If target revocation succeeded but local cleanup failed, retain that durable state and retry cleanup without using the deleted token.

Adapters without target revocation cannot claim successful removal. Registration
failure after pairing attempts to revoke the newly created authorization. If its
outcome cannot be established, reconcile on the target with `/agent-link list`
and `/agent-link revoke <id>` before pairing again.

Registration establishes connectivity and scoped capabilities. It does not grant
project membership, share files, distribute Git credentials or delete already
accepted work/history when removed.

## Headless management

- `/agent-hub list`
- `/agent-hub check <id>`
- `/agent-hub update {"agentId":"…","patch":{"name":"…","color":"#123456"}}`
- `/agent-hub remove <id>`

All mutations and connection checks participate in the host foreground-work and
shutdown lifecycle. Backend state remains owner-scoped.
