// ============================================================
// middleware/rateLimit.ts
// In-memory store (the default) — fine on one instance. If this
// ever runs across multiple processes, each one enforces its own
// independent limit until this moves to a shared store (e.g.
// rate-limit-redis) — looser than intended, never dangerous.
// ============================================================
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

// authMiddleware runs before these on every route that uses them,
// so req.userId is set — key by user where we can, IP as fallback.
function userOrIpKey(req: Request): string {
  return req.userId ?? ipKeyGenerator(req.ip ?? '');
}

// Blunt safety net on every /api/* route — runs before auth even
// fires, so this one is always IP-based. Generous enough that no
// real usage pattern should ever hit it.
export const defaultLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down.' },
});

// Search gets hit once per keystroke even with client-side debounce
// — generous, but still capped against scraping.
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: {
    success: false,
    message: 'Too many search requests, please slow down.',
  },
});

// Anything that writes — friend requests, invites, profile/group
// edits. Real users do these rarely; spam is the only reason to
// hit this.
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { success: false, message: 'Too many requests, please slow down.' },
});
