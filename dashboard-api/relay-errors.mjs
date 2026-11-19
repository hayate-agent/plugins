// Operator-facing reasons for failures between the dashboard and a connected agent.
// Only these fixed texts are ever shown; raw error messages never leave the server.
const KNOWN = [
  [/^Outbound agent disconnected/, 503, 'The agent is not connected right now; nothing was sent. Start or reload its connector, then try again.'],
  [/^Agent disconnected/, 502, 'The agent disconnected while working; the message may or may not have been delivered. Check the chat before sending it again.'],
  [/^Agent response timed out/, 504, 'The agent did not answer in time; the message may still be processed. Check the chat before sending it again.'],
  [/^Agent send failed/, 502, 'Sending to the agent failed; the message may or may not have been delivered. Check the chat before sending it again.'],
  [/^Target refused/, 502, 'The agent refused the request (it may run an older connector). Reload or update its connector.'],
  [/^Relay request/, 503, 'The relay is busy or the request is too large; nothing was sent. Try again in a moment.'],
  [/^(Wait cancelled|Request cancelled)/, 499, 'The request was cancelled; accepted work may continue. Check the chat.'],
];
export function describeAgentFailure(error) {
  const message = String(error?.message ?? '');
  for (const [pattern, status, text] of KNOWN) if (pattern.test(message)) return { status, error: text };
  return { status: 502, error: 'Agent operation failed or outcome unknown; check the chat before sending again.' };
}
