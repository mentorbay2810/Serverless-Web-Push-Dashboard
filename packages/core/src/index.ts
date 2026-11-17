export interface BrowserSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export interface NotificationContent {
  title: string;
  body: string;
  url: string;
}

export interface PushPayload extends NotificationContent {
  version: 1;
  notificationId: string;
  sentAt: string;
}

export interface StoredSubscription {
  id: string;
  subscription: BrowserSubscription;
  tokenHash: string;
  createdAt: string;
  lastAcceptedAt?: string;
}

export interface SubscriptionSummary {
  id: string;
  provider: string;
  createdAt: string;
  lastAcceptedAt?: string;
}

export interface PublicConfig {
  vapidPublicKey: string;
  mode: 'local';
  maxSubscriptions: number;
}

export interface PushSender {
  send(subscription: BrowserSubscription, payload: PushPayload): Promise<{ statusCode: number }>;
}

export interface SubscriptionStore {
  list(): Promise<StoredSubscription[]>;
  get(id: string): Promise<StoredSubscription | undefined>;
  insert(record: StoredSubscription, limit: number): Promise<void>;
  remove(id: string): Promise<void>;
  markAccepted(id: string, date: string): Promise<void>;
}

export class AppError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export const DEFAULT_NOTIFICATION: NotificationContent = {
  title: 'Hello from Web Push',
  body: 'Your first web push notification made it from the server to this browser.',
  url: '/',
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new AppError(400, `${name} must contain 1–${max} characters.`);
  }
  return value.trim();
}

function key(value: unknown, name: string, bytes: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError(400, `Invalid ${name} encryption key.`);
  }
  try {
    const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    if (decoded.length !== bytes || (bytes === 65 && decoded.charCodeAt(0) !== 4)) throw new Error();
  } catch { throw new AppError(400, `Invalid ${name} encryption key.`); }
  return value;
}

export function parseSubscription(value: unknown): BrowserSubscription {
  const input = object(value);
  const endpoint = text(input.endpoint, 'Endpoint', 2048);
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new AppError(400, 'Invalid push endpoint.'); }
  const host = url.hostname;
  const supported = host === 'fcm.googleapis.com'
    // Chromium also defines this exact Google staging push hostname.
    || host === 'jmt17.google.com'
    || host === 'updates.push.services.mozilla.com'
    || host.endsWith('.push.services.mozilla.com')
    || host === 'web.push.apple.com'
    || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || !supported || url.username || url.password || url.hash || url.port) {
    throw new AppError(400, `This browser's push service (${host}) is not supported. Use Chrome, Edge, Firefox, or Safari with an HTTPS browser push endpoint.`);
  }
  const keys = object(input.keys);
  const expiration = input.expirationTime;
  if (expiration !== undefined && expiration !== null
    && (typeof expiration !== 'number' || !Number.isFinite(expiration) || expiration <= 0)) {
    throw new AppError(400, 'Invalid subscription expiration.');
  }
  return {
    endpoint: url.href,
    expirationTime: typeof expiration === 'number' ? expiration : null,
    keys: { p256dh: key(keys.p256dh, 'p256dh', 65), auth: key(keys.auth, 'auth', 16) },
  };
}

export function parseNotification(value: unknown): NotificationContent {
  const input = object(value);
  const url = input.url ?? '/';
  if (typeof url !== 'string' || url.length > 512 || !url.startsWith('/')
    || url.startsWith('//') || /[\\\u0000-\u001f]/.test(url)) {
    throw new AppError(400, 'Notification URL must be a path on this website.');
  }
  return { title: text(input.title, 'Title', 80), body: text(input.body, 'Body', 240), url };
}

export function summarize(record: StoredSubscription): SubscriptionSummary {
  return {
    id: record.id,
    provider: new URL(record.subscription.endpoint).hostname,
    createdAt: record.createdAt,
    ...(record.lastAcceptedAt ? { lastAcceptedAt: record.lastAcceptedAt } : {}),
  };
}
