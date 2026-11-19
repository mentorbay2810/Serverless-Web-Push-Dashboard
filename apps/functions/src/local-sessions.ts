import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../../packages/core/src/index.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Local-only, process-scoped sessions. A restart revokes all codes and sessions. */
export class LocalAdminSessions {
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  private prune() {
    for (const table of [this.codes, this.sessions]) for (const [key, expiry] of table) if (expiry <= this.now()) table.delete(key);
  }
  issue() {
    this.prune();
    if (this.codes.size >= 5) throw new AppError(429, 'Too many unused sign-in links. Wait two minutes.');
    const code = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + 120_000;
    this.codes.set(digest(code), expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  exchange(code: unknown) {
    this.prune();
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new AppError(401, 'Generate a fresh local administrator sign-in link.');
    const key = digest(code);
    if (!this.codes.has(key)) throw new AppError(401, 'This sign-in link expired or was already used. Generate another.');
    this.codes.delete(key);
    if (this.sessions.size >= 10) throw new AppError(429, 'Too many active local sessions. Sign out or wait for expiry.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + 3_600_000;
    this.sessions.set(digest(token), expiresAt);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }
  authorized(header: string | null) {
    this.prune();
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    return /^[A-Za-z0-9_-]{43}$/.test(token) && this.sessions.has(digest(token));
  }
  revoke(header: string | null) {
    if (!this.authorized(header)) throw new AppError(401, 'Local administrator session is unavailable.');
    this.sessions.delete(digest(header!.slice(7)));
  }
}
