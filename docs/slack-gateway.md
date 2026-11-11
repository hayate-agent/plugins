# Local Slack gateway: DMs, engaged channel threads and files

This is an optional trusted GatewayModule v1, not a bundled Core channel. It uses
Node's native fetch/WebSocket and `node:crypto`, with no package installation at
runtime. Use Node 24 (the tested runtime). One workspace per process, discovered
from the bot token. DMs work without mentions and share a stable per-DM session.
In public/private channels, an explicit mention (whether delivered as `app_mention`
or as a normal `message` event containing the bot mention) engages a thread; subsequent
messages in that thread continue without another mention, including after restart.
Other channel traffic is ignored by default. Per-channel access, activation and reply
location can be configured through the shared conversation-policy contract below.
Thread membership is atomically persisted without
message contents. A channel allowlist is optional, not required for connection.
Inbound files and supported images use Core's session-bound attachment contract v1.
History import, group-DM conversation handling, reactions and interactive approvals
are not implemented. Core's native messaging tool supports images/binary uploads
with an optional caption, new channel posts, DMs and thread replies.

## 1. Prepare the Slack app (administrator)

1. Create an internal Slack app from `examples/slack-app-manifest.json` in the
   intended test workspace. The manifest requests `app_mentions:read`,
   `chat:write`, `files:read`, `im:history`, `channels:history`, `groups:history`,
   `channels:read` and `groups:read`. The last two permit joined-channel discovery.
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

The manifest includes `files:write` for the native file-send path. Existing installs
need reinstalling only if that scope is missing; never assume a checked-in manifest
changed the scopes of an already issued token. No slash-command or interactive-event permissions are requested. DM and channel
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
`src/slack-upload.mjs`, `src/slack-threads.mjs` and `src/conversation-policy.mjs` from
the same pinned plugin commit into a new versioned directory, for example:

```
<home>/plugins/slack/<commit>/slack-gateway.mjs
<home>/plugins/slack/<commit>/slack-files.mjs
<home>/plugins/slack/<commit>/slack-upload.mjs
<home>/plugins/slack/<commit>/slack-threads.mjs
<home>/plugins/slack/<commit>/conversation-policy.mjs
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

## Channel policy: defaults, access and replies

Use the shared Core `gateways.overrides.slack.conversation` contract, not Slack
scopes or prompt prose as a substitute for admission policy:

```yaml
gateways:
  overrides:
    slack:
      conversation:
        allowedChannels: "*"
        defaults:
          users: "*"
          activation: threads
          replyLocation: thread
        channels:
          C_PRIVATE_OPERATOR:
            activation: open
            replyLocation: channel
          C_RESTRICTED:
            users: [U_OPERATOR_ID]
            activation: mentions
```

`users: "*"` permits all human users; `users: []` denies all. Unknown/new channels
inherit the defaults. Channel overrides change only the named fields.
`activation` is `mentions` (mention every time), `threads` (mention to engage,
then thread follow-ups), `open` (consider unaddressed input but allow NO_REPLY),
or `disabled`. `replyLocation` is `thread` or `channel`; channel-level replies
share a stable channel conversation. DMs still require no mention but enforce
access restrictions. User checks happen before thread lookup or attachment
download. Own/bot messages and edits cannot cause loops. This grants no admin
or approver rights and does not auto-join Slack channels. The legacy
`SLACK_CHANNEL_IDS` allowlist, if set, remains an additional hard restriction.

An authenticated Core administrator can use `/conversation-policy defaults slack
<JSON>`, `/conversation-policy channel slack <ID> <JSON>`, and
`/conversation-policy channels slack <"*" or JSON ID array>` for persistent live
changes. Local/installation/drop-in files use the ordinary restart/activation
lifecycle. New restrictive policy on an older unsupported adapter fails closed.

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
  The factory declares `updateAdmission: "foreground-owned"`: creation is inert,
  reconnects belong to the stopped channel, and shutdown synchronously fences
  new ingress and outbound sends. Shutdown waits for the socket to close and for
  accepted ingress, outbound response bodies and complete upload/persistence
  operations to settle. Timeout is an error, never a claim of safe replacement.
  Failed delivery outcomes still reach Core's durable outbox; shutdown does not
  replay them or claim unknown external effects succeeded. A failed start can be followed by the manager's
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

Files in an admitted event are handled, including attachment-only messages.
Missing URL/size metadata is resolved with bounded authenticated `files.info` by
exact file ID before download; missing/unavailable metadata fails visibly.
A rejected user or channel cannot trigger file lookups/downloads. Slack file
visibility/event shape must still be verified with the installed app. Downloads reject redirects, non-HTTPS and hosts other than
`files.slack.com`; tokens must never follow an external redirect.

No automatic blob garbage collection is implemented. Preserve files for queued
inputs and runtime references; monitor persistent-volume capacity and apply an
operator-managed retention policy only after proving references are no longer
needed. This is not unlimited archival storage.

## 4. Outbound behavior and operational limits

### Native discovery and operator-authorized sends

On Core versions exposing `plugin_message`, active Slack availability and destination
format are supplied as host facts on every turn, including conversations on Matrix,
API or another gateway. `plugin_message status` inspects live gateways;
`destinations` with `gateway: "slack"` pages joined public/private channels using
`users.conversations`. It never lists all workspace channels or joins channels.
Slack does not include `is_member` on that endpoint: do not filter away real
memberships based on the absent field. Names are untrusted data; use exact target
IDs and follow `nextCursor`. This read-only listing requires `channels:read` and
`groups:read`; missing scopes fail explicitly without hiding working send support.
Existing installations that already grant these scopes need no Slack reinstall.

`plugin_message send` accepts `gateway`, `target`, `text` and a stable `requestId`.
For a file, supply `file: {path, name?}` and optional caption in `text`. The path
must be a regular current-workspace file or an inbound blob owned by this
conversation. Core snapshots at most 10 MiB, validates scope/name/hash and passes
a host-bound attachment to Slack; no arbitrary file paths cross the adapter API.
The external-upload API supports new channel posts, DMs and exact thread replies.
The adapter verifies bytes and persists allocation/transfer/completion state;
unknown effects are never blindly replayed. `files` capability is advertised only
on hosts with the required outbound attachment contract.
Omit `thread` for a new channel post (or DM); provide the exact timestamp for a
thread reply. Membership and discovery grant no permission: the operator's current
mandate still authorizes the destination and message. The tool stores no-replay
receipts; retries with the same request return the retained outcome, and uncertain
sends require reconciliation. Never work around tool availability by retrieving
credentials or invoking a shell HTTP client. On older Core, automatic replies
work, but the model-visible discovery/send tool is unavailable until Core rollout.

Every logical text reply uses one `chat.postMessage` call, with `thread_ts` only
when replying in a thread, link/media
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
