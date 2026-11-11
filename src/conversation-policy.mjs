// Transport-neutral conversation policy v1. No Core/runtime imports or side effects.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const ids = value => value === '*' || Array.isArray(value) && value.length <= 256 &&
  value.every(id => typeof id === 'string' && !!id.trim() && id.length <= 256);
export function conversationPolicy(value) {
  const rule = input => {
    if (!object(input)) throw Error('Invalid conversation rule');
    for (const [key, field] of Object.entries(input)) {
      if (key === 'activation' && ['mentions', 'threads', 'open', 'disabled'].includes(field)) continue;
      if (key === 'replyLocation' && ['thread', 'channel'].includes(field)) continue;
      if (key === 'users' && ids(field)) continue;
      throw Error('Invalid conversation rule field');
    }
  };
  if (value !== undefined) {
    if (!object(value)) throw Error('Invalid conversation policy');
    for (const [key, field] of Object.entries(value)) {
      if (key === 'defaults') rule(field);
      else if (key === 'allowedChannels' && ids(field)) continue;
      else if (key === 'channels' && object(field) && Object.keys(field).length <= 256) {
        for (const [id, settings] of Object.entries(field)) {
          if (!id.trim() || id.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw Error('Invalid conversation channel ID');
          rule(settings);
        }
      } else throw Error('Invalid conversation policy field');
    }
  }
  return structuredClone({ allowedChannels: value?.allowedChannels ?? '*',
    defaults: { activation: 'threads', replyLocation: 'thread', users: '*', ...value?.defaults },
    channels: value?.channels ?? {} });
}
export function conversationRule(policy, channel) {
  return { ...policy.defaults, ...(own(policy.channels, channel) ? policy.channels[channel] : {}) };
}
export function channelAllowed(policy, channel) {
  return policy.allowedChannels === '*' || policy.allowedChannels.includes(channel);
}
export function userAllowed(rule, user) {
  return typeof user === 'string' && (rule.users === '*' || rule.users.includes(user));
}
