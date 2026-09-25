/**
 * Types for latest-release-lib.mjs so `lib/latest-release-sync.test.ts` can
 * import the sync decisions under `allowJs: false`. Keep in step with the
 * runtime module.
 */

/** The four release fields mirrored across the three checked-in facts. */
export interface ReleaseFact {
  tag: string;
  version: string;
  publishedAt: string;
  url: string;
}

/** The subset of the GitHub release payload the sync reads. */
export interface ReleasePayload {
  tag_name?: string | null;
  published_at?: string | null;
}

export interface CloudFactsRelease {
  latest?: string | null;
  release_url?: string | null;
}

export interface CloudFacts {
  release?: CloudFactsRelease | null;
}

export interface SurfaceMatrix {
  latestPublishedRelease?: ReleaseFact | null;
  /** The matrix carries extra keys (notably `sources`) that the sync preserves. */
  [key: string]: unknown;
}

export type SyncPlan =
  | { kind: "refuse"; reason: "mirror-unreadable" | "cloud-facts-unreadable" }
  | { kind: "current" }
  | {
      kind: "stale";
      staleTarget: boolean;
      staleMirror: boolean;
      mirrorAgreesWithTarget: boolean;
    }
  | { kind: "write" };

export interface PlanReleaseSyncInput {
  current: ReleaseFact | null;
  matrix: SurfaceMatrix | null;
  cloud: CloudFacts | null;
  next: ReleaseFact;
  checkOnly: boolean;
}

export function releaseFactFromRelease(
  release: ReleasePayload | null | undefined,
  repo: string,
): ReleaseFact | null;
export function releaseFactMatches(fact: ReleaseFact | null, next: ReleaseFact): boolean;
export function cloudFactsMatch(cloud: CloudFacts | null | undefined, next: ReleaseFact): boolean;
export function planReleaseSync(input: PlanReleaseSyncInput): SyncPlan;
