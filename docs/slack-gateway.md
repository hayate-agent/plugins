# Local Slack gateway: DMs, engaged channel threads and files

This is an optional trusted GatewayModule v1, not a bundled Core channel. It uses
Node's native fetch/WebSocket and `node:crypto`, with no package installation at
runtime. Use Node 24 (the tested runtime). One workspace per process, discovered
from the bot token. DMs work without mentions and share a stable per-DM session.
In public/private channels, an explicit mention engages a thread; subsequent
messages in that thread continue without another mention, including after restart.
Other channel traffic is ignored. Thread membership is atomically persisted without
message contents. A channel allowlist is optional, not required for connection.
Inbound files and supported images use Core's session-bound attachment contract v1.
History import, group-DM conversation handling, reactions and interactive approvals
are not implemented. The outbound upload adapter is locally tested, but the usable
Core-to-agent file-send integration remains unfinished, not removed from the mandate.

## 1. Prepare the Slack app (administrator)

1. Create an internal Slack app from `examples/slack-app-manifest.json` in the
   intended test workspace. The manifest requests `app_mentions:read`,
   `chat:write`, `files:read`, `im:history`, `channels:history` and `groups:history`.
   Events are `app_mention`, `message.im`, `message.channels` and `message.groups`.
   Message/history scopes are required to receive DM and channel-thread events;
   the adapter does not call history APIs or import channel archives. Socket Mode
   needs no public Request URL.
2. Under Basic Information → App-Level Tokens generate an app token with
   `connections:write`. This app-level scope is separate from bot OAuth scopes;
   it is not silently granted by the manifest.
3. Install the app into that workspace and obtain its bot OAuth token. Reinstall
   after any future scope change. Invite the bot into the isolated test channel.
4. No workspace or channel IDs are required for normal setup: `auth.test` supplies
   the workspace and bot identity, and events supply channel/thread IDs. Optionally
   restrict the workspace or channels as described below. Slack administrative
   status does not grant Hayate administrator rights.

The manifest deliberately excludes `files:write`: the local upload adapter has
fake-transport tests, but the Core-to-agent outbound file-send contract is not yet
complete. Add that scope and reinstall the app only when the usable upload path
is delivered. No slash-command or interactive-event permissions are requested. DM and channel
message scopes are explicitly paired with their corresponding events. App-level `connections:write` is generated separately, not a bot scope.

The manifest disables token rotation for this minimal internal app. If rotation
is required by policy, implement refresh support before using this adapter.
Do not publish this Socket Mode app to the Marketplace.

## 2. Provision configuration and install the module

Through the existing secret/deployment process, provide these environment values
to the agent process (never commit the actual values):

- `SLACK_APP_TOKEN`: app-level token, normally `xapp-…`.
- `SLACK_BOT_TOKEN`: bot OAuth token, normally `xoxb-…`.
These **two tokens are the only required Slack settings**. With neither token
set, the factory returns unconfigured; with only one, it fails closed.

Optional restrictions (leave unset for normal setup):

- `SLACK_TEAM_ID`: pin the discovered workspace to this ID (`T…`); mismatch fails.
- `SLACK_CHANNEL_IDS`: comma-separated channel allowlist (`C…` / `G…`), no wildcard.
  When unset, mentions can be handled in any channel accessible to the bot.

IDs are stable identifiers, not display names. Restricting channels is an operator
policy choice, not a Slack authentication requirement. Environment updates require the normal authorized process rollout;
plugin reload cannot replace a process environment. Tokens are not read from chat
messages or included in error messages.

**Dependency / deployment order:** first deliver the Core change providing
`GatewayFactoryContext.inboundAttachments = 1`, durable session-bound inbound
references and runtime image plumbing (Core PR #282, merge
`cbec53bfa46bda14b17f162ad231c5042e4daba4`).
The configured factory refuses older hosts instead of silently dropping images.
Pin the reviewed Core and plugin commits in the actual deployment; a branch name
is not a release or evidence of activation.

Copy the reviewed **exact** `src/slack-gateway.mjs`, `src/slack-files.mjs`,
`src/slack-upload.mjs` and `src/slack-threads.mjs` from
the same pinned plugin commit into a new versioned directory, for example:

```
<home>/plugins/slack/<commit>/slack-gateway.mjs
<home>/plugins/slack/<commit>/slack-files.mjs
<home>/plugins/slack/<commit>/slack-upload.mjs
<home>/plugins/slack/<commit>/slack-threads.mjs
```

Use normal artifact/GitOps provisioning; no runtime downloads or mutable shared
imports. This standalone `.mjs` is not a materialized TypeScript builtin and must
not be added blindly to Core's `plugins.lock.json` or generated `builtin-plugins`.

An authorized operator then selects the installed module:

```
/gateway-plugin use slack plugins/slack/<commit>/slack-gateway.mjs
/gateway-plugin status
```

The existing manager supports arbitrary non-reserved gateway IDs including
`slack`; desired selection is persisted under `gatewayPlugins`. Activation waits
for the existing safe idle boundary. `create()` performs no network operations;
`start()` checks the token's workspace with `auth.test` before opening the socket.
The adapter does not change the default home destination or operator/admin list.
If private administrative access is required, configure the explicit sender ID
`slack:<workspace-id>:<user-id>` through the existing operator configuration;
do not broaden an existing admin list merely to test chat delivery.

## 3. Verify before admitting ordinary use

- Mention the bot in a channel it has joined (and, if configured, allowed by the optional restriction): the answer must be in that message's
  thread. An explicit mention in the thread continues that same session.
- Verify no response to bot messages, edited messages, unmentioned messages or
  channels outside an explicitly configured allowlist. Without an allowlist, verify
  a second joined channel works without additional configuration. Session keys include workspace, channel and
  exact string thread timestamp. Input IDs use workspace/channel/message timestamp. This also deduplicates app_mention and
  message events for the same message through Core's durable inbox, even when
  Slack assigns different event IDs. Socket envelopes are acknowledged individually.
- Core's `deliverInbound` promise must represent **durable** inbox acceptance;
  only then is the Socket Mode envelope acknowledged. If storage fails, no ACK
  is sent; disconnect permits upstream redelivery. Redelivery deduplication is
  Core-owned, not an in-memory plugin claim of exactly-once processing.
- Verify reconnect, process restart and persisted module selection in the actual
  deployment. The local fake tests do not prove those live properties.
- Replace with another version and check that the old receiver stops first.
  Shutdown waits for accepted ingress to drain; timeout is an error, never a
  claim of safe replacement. A failed start can be followed by the manager's
  existing stop/rollback sequence. Versioned paths avoid the ESM cache trap.

## Attachment storage and trust boundary

Up to four inbound files, 10 MiB each and 20 MiB total per message. Files are
stored below `<home>/attachments/<SHA256(sessionKey)>/<SHA256(bytes)>`, synced to
disk before durable inbox acceptance and reverified before prompting. A foreign
session cannot relabel a reference to read another session's directory. Root and
parent directories are trusted operator-owned storage, not a sandbox against a
malicious local process with access to the agent home. Core uses no-follow regular
file opens and bounded reads. Image signatures select PNG/JPEG/GIF/WebP; this is
not a complete image decoder or malware scanner. The provider may reject malformed
images. A model without image capability fails explicitly. Other binaries are
provided as local file references, not automatically parsed.

Only files in the actual mention event are handled; missing file URLs/metadata
fail rather than claiming successful analysis. Slack file visibility/event shape
must be verified with the installed app; fallback `files.info` lookup is not yet
implemented. Downloads reject redirects, non-HTTPS and hosts other than
`files.slack.com`; tokens must never follow an external redirect.

No automatic blob garbage collection is implemented. Preserve files for queued
inputs and runtime references; monitor persistent-volume capacity and apply an
operator-managed retention policy only after proving references are no longer
needed. This is not unlimited archival storage.

## 4. Outbound behavior and operational limits

Every logical text reply uses one `chat.postMessage` call with `thread_ts`, link/media
unfurling disabled, and a deterministic UUID derived from Core delivery ID plus
workspace/channel/thread. Do not interpret `client_msg_id` as a proven Slack
exactly-once guarantee. When Core supplies no delivery ID there is no such hint.

HTTP 429 records the method's `Retry-After` cooldown (integer seconds); calls
before it expires fail locally without a request. Missing/invalid headers use
60 seconds, zero uses one second. Slack logical `ratelimited` errors also use
60 seconds. This avoids sleeping in an active send or internally replaying it.
Core retains its normal outbox retry schedule; `retryAt` on the error is diagnostic
metadata, not a new Core scheduling contract. Cooldowns are process-local and
reset on restart. They are conservative per method, not a full workspace quota
scheduler.

Network failures, malformed replies and 5xx after a post are marked ambiguous.
The adapter performs **no internal resend**. Core may retry the outbox entry using
the same delivery ID; duplicate Slack posts remain possible after ambiguous
outcomes. Audit the thread before manual replay. No exactly-once claim is made.

Known Slack API error codes are reported without response payloads or tokens.
Permission/configuration errors propagate to Core; this standalone plugin has no
shared `PermanentDeliveryError` constructor, so such entries are not automatically
parked. Correct the app membership/scopes or use the existing authorized outbox
reconciliation path. Never silently acknowledge a failed outbound delivery.

Replies above 39,000 Unicode code points are rejected before posting (Slack
truncates above 40,000). This initial adapter does not split replies: chunking
without persisted per-chunk identities would introduce partial-delivery replays.
Do not use it for oversized reports until a tested durable chunking/file policy
is supplied. Slack's recommendation remains much shorter messages (~4,000).

## 5. Disable / rollback

```
/gateway-plugin disable slack
/gateway-plugin status
```

Restore by selecting the previous immutable module path. Do not use `baseline
slack`: Slack has no bundled baseline. Revoke the tokens only after stopping the
receiver, unless urgent credential containment requires immediate revocation.
Keep secrets out of logs, commits and example configuration.

## Local checks (no Slack calls)

```
node --test test/slack*.test.mjs
node --check src/slack-gateway.mjs
```

No Slack installation, token authentication, live acceptance test or activation
is implied by these checks. References: Slack Socket Mode documentation at
https://docs.slack.dev/apis/events-api/using-socket-mode/ and chat.postMessage at
https://docs.slack.dev/reference/methods/chat.postMessage/.
