const localPart = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const MAX_EMAILS = 100;
export const KEY_PATTERN = /^sl_live_[A-Za-z0-9_-]{43}$/;

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length > 254 || /[^\x21-\x7e]/.test(trimmed)) return null;
  const email = trimmed.toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  const labels = domain.split('.');
  if (local.length > 64 || !localPart.test(local) ||
      labels.length < 2 || !labels.every(label => domainLabel.test(label))) return null;
  return email;
}
