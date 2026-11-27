/** The one thing an operator pastes into a target agent: everything the agent needs, nothing to fill in. */
export const INVITATION_LIFETIME_MS = 60 * 60 * 1000;

export function enrollmentPrompt({ name, endpoint, code, expiresAt }) {
  const until = new Date(expiresAt).toISOString();
  return `Connect this agent to the central Hayate dashboard "${endpoint}" as "${name}".

This is a task for you, not a shell command and not a slash command. Do it yourself, step by step, and report each step briefly.

Connection data (single use, valid until ${until}):
- Dashboard (HTTPS origin): ${endpoint}
- Invitation code: ${code}

Rules: never print the invitation code again, never write it to a file, memory, log or commit, and never open the dashboard in a browser. Your own connection token is created for you and kept in your credential vault.

1. If you have the tool \`plugin_agent_link_connect\`, skip to step 3.
2. Otherwise this agent still needs the outbound AgentLink components. Enable them in this agent's plugin configuration, keeping every plugin that is already enabled and adding only what is missing, in this order (paths are relative to this installation's plugins directory):
   - credentials/index.mjs
   - workspace/index.mjs
   - agent-link/outbound.mjs
   Create or extend \`agent-link-outbound.json\` in this agent's home directory (keep existing entries, add the relay if it is missing):
   {"relays":[{"origin":"${endpoint}"}],"capabilities":["projects","streams","messages","activity"],"projects":{},"shareStandalone":true}
   Then restart or reload this agent the way you normally apply plugin changes and confirm that \`plugin_agent_link_connect\` exists. Do not install anything else and do not change other settings. No inbound port is needed: this agent only connects outward over HTTPS.
3. Call \`plugin_agent_link_connect\` with action "enroll", endpoint "${endpoint}" and the invitation code above. Then call it with action "status" and check that it is connected.
4. Tell the operator: "Connected, waiting for approval in the dashboard under Agents → incoming connections." Approval happens centrally; do not try to approve it yourself.

If the code is rejected or has expired, stop and ask the operator for a new prompt. Do not retry with other codes or other endpoints.`;
}
