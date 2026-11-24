/**
 * Auth boundary. The rest of the app only sees `req.user` (a User or null)
 * plus the requireLogin / requirePerm middlewares.
 *
 * Today: a dev connector that logs you in as `perryh` with every permission,
 * switchable at /dev. Later: swap `resolveUser` for the @simmons-tech/auth
 * OIDC session + membrane AuthZ lookup. Nothing else should need to change.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { IncomingMessage } from "node:http";
import type { Session, SessionData } from "express-session";
import { config } from "../config";
import { User, ALL_PERMS, PermCheck } from "./permissions";

declare module "express-session" {
  interface SessionData {
    devUser?: string;
    devPerms?: string[];
    devLoggedOut?: boolean;
    flash?: { type: string; message: string }[];
    // NB: never store secret-ballot vote IDs here; the session identifies the user.
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: User | null;
      flash: (type: string, message: string) => void;
    }
  }
}

type WithSession = { session?: Session & Partial<SessionData> };

export function resolveUser(req: (Request | IncomingMessage) & WithSession): User | null {
  if (config.devAuth) {
    const s = req.session;
    if (!s || s.devLoggedOut) return null;
    return new User(s.devUser || config.devDefaultUser, s.devPerms || ALL_PERMS);
  }
  // TODO(membrane): return req.oidcUser ? new User(sub, await authz.permissionsFor(sub)) : null
  return null;
}

export const attachUser: RequestHandler = (req, res, next) => {
  req.user = resolveUser(req);
  res.locals.user = req.user;
  next();
};

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (req.user) return next();
  res.status(401).render("error", { title: "Sign in required", message: "Please sign in with Simmons SSO to continue." });
}

/** requirePerm(GOVPERMS.MANAGE) or requirePerm([A, B]) (any of). */
export function requirePerm(perm: PermCheck): RequestHandler {
  return (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (req.user.hasPermission(perm)) return next();
    const names = Array.isArray(perm) ? perm.join(" or ") : String(perm);
    res.status(403).render("error", { title: "Not allowed", message: `You need the ${names} permission.` });
  };
}
