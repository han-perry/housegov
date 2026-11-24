import { config } from "../config";

/** Permission strings, matching the future membrane / AuthZ connector. */
export enum GOVPERMS {
  PROPOSE = "govtracker.propose",
  MANAGE = "govtracker.manage",
  PRESENTATION = "govtracker.presentation",
  DOCS_MANAGE = "govtracker.docs.manage",
  // Not in the spec yet: who is eligible to vote in polls / ad hoc votes.
  VOTE = "govtracker.vote",
}

export const ALL_PERMS: GOVPERMS[] = Object.values(GOVPERMS);

export type PermCheck = GOVPERMS | string | Array<GOVPERMS | string> | typeof GOVPERMS;

export class User {
  readonly permissions: Set<string>;

  constructor(
    readonly username: string,
    permissions: Iterable<string> = []
  ) {
    this.permissions = new Set(permissions);
  }

  /**
   * hasPermission(GOVPERMS.MANAGE), hasPermission([A, B]), or
   * hasPermission(GOVPERMS) — true if the user has ANY of them.
   */
  hasPermission(perm: PermCheck): boolean {
    const perms: string[] = Array.isArray(perm) ? perm : typeof perm === "object" ? Object.values(perm) : [perm];
    return perms.some((p) => this.permissions.has(p));
  }

  get email(): string {
    return `${this.username}@${config.mailDomain}`;
  }
}
