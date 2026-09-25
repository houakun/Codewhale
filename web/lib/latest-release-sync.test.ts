import { describe, expect, it } from "vitest";

import type { CloudFacts, PlanReleaseSyncInput, ReleaseFact } from "../scripts/latest-release-lib.mjs";
import {
  cloudFactsMatch,
  planReleaseSync,
  releaseFactFromRelease,
  releaseFactMatches,
} from "../scripts/latest-release-lib.mjs";

const REPO = "Hmbown/CodeWhale";

const NEXT = {
  tag: "v1.2.3",
  version: "1.2.3",
  publishedAt: "2026-09-25T00:00:00Z",
  url: `https://github.com/${REPO}/releases/tag/v1.2.3`,
};

const STALE = {
  ...NEXT,
  tag: "v1.2.2",
  version: "1.2.2",
  publishedAt: "2026-09-01T00:00:00Z",
  url: `https://github.com/${REPO}/releases/tag/v1.2.2`,
};

// Shape the matrix the way the real file does: the four synced fields plus the
// extra keys (notably `sources`) the sync must preserve.
const matrixFor = (fact: ReleaseFact | null) => ({
  latestPublishedRelease: fact,
  sources: ["web/data/latest-published-release.json"],
});
const cloudFor = (fact: ReleaseFact): CloudFacts => ({
  release: { latest: fact.version, release_url: fact.url },
});
const plan = (overrides: Partial<PlanReleaseSyncInput> = {}) =>
  planReleaseSync({
    current: NEXT,
    matrix: matrixFor(NEXT),
    cloud: cloudFor(NEXT),
    next: NEXT,
    checkOnly: false,
    ...overrides,
  });

describe("releaseFactFromRelease", () => {
  it("builds the four mirrored fields from a GitHub payload", () => {
    expect(
      releaseFactFromRelease(
        { tag_name: "v1.2.3", published_at: "2026-09-25T00:00:00Z" },
        REPO,
      ),
    ).toEqual(NEXT);
  });

  it("refuses payloads that would drop or corrupt the fact", () => {
    expect(releaseFactFromRelease(null, REPO)).toBeNull();
    expect(releaseFactFromRelease(undefined, REPO)).toBeNull();
    // No `v` prefix: deriveLatestPublishedRelease would silently return null.
    expect(
      releaseFactFromRelease({ tag_name: "1.2.3", published_at: "2026-09-25T00:00:00Z" }, REPO),
    ).toBeNull();
    expect(releaseFactFromRelease({ tag_name: "v1.2.3", published_at: "nope" }, REPO)).toBeNull();
    expect(releaseFactFromRelease({ published_at: "2026-09-25T00:00:00Z" }, REPO)).toBeNull();
  });
});

describe("planReleaseSync", () => {
  it("reports current when every mirror already matches", () => {
    expect(plan()).toEqual({ kind: "current" });
  });

  it("refuses to write when a mirror is unreadable", () => {
    // The ordering bug this guards: the target used to be written before the
    // mirror was read, so an unreadable mirror left the three facts split.
    expect(plan({ matrix: null })).toEqual({ kind: "refuse", reason: "mirror-unreadable" });
    expect(plan({ cloud: null })).toEqual({ kind: "refuse", reason: "cloud-facts-unreadable" });
    expect(plan({ cloud: { release: null } })).toEqual({
      kind: "refuse",
      reason: "cloud-facts-unreadable",
    });
  });

  it("refuses in --check mode too, so an unreadable mirror is never green", () => {
    expect(plan({ matrix: null, checkOnly: true })).toEqual({
      kind: "refuse",
      reason: "mirror-unreadable",
    });
  });

  it("writes when a readable record is behind", () => {
    expect(
      plan({ current: STALE, matrix: matrixFor(STALE), cloud: cloudFor(STALE) }),
    ).toEqual({ kind: "write" });
  });

  it("marks --check stale per mirror", () => {
    expect(plan({ current: STALE, matrix: matrixFor(STALE), cloud: cloudFor(STALE), checkOnly: true })).toEqual({
      kind: "stale",
      staleTarget: true,
      staleMirror: true,
      mirrorAgreesWithTarget: true,
    });
  });

  it("only grants the 24h grace window when target and mirror agree", () => {
    // A split record is never "just catching up": the caller must not exit 0.
    expect(plan({ current: STALE, matrix: matrixFor(NEXT), cloud: cloudFor(STALE), checkOnly: true })).toEqual({
      kind: "stale",
      staleTarget: true,
      staleMirror: false,
      mirrorAgreesWithTarget: false,
    });
    expect(plan({ current: NEXT, matrix: matrixFor(STALE), cloud: cloudFor(NEXT), checkOnly: true })).toEqual({
      kind: "stale",
      staleTarget: false,
      staleMirror: true,
      mirrorAgreesWithTarget: false,
    });
  });

  it("keeps --check green when target and mirror match even if cloud facts lag", () => {
    // Preserves the original --check contract: only the two checked-in release
    // facts gate it; cloud facts are refreshed by the write path.
    expect(plan({ cloud: { release: { latest: "0.0.1", release_url: "other" } }, checkOnly: true })).toEqual({
      kind: "current",
    });
  });
});

describe("fact matchers", () => {
  it("matches on tag and publishedAt, not on tag alone", () => {
    expect(releaseFactMatches(NEXT, NEXT)).toBe(true);
    expect(releaseFactMatches({ ...NEXT, publishedAt: "2026-01-01T00:00:00Z" }, NEXT)).toBe(false);
    expect(releaseFactMatches(null, NEXT)).toBe(false);
  });

  it("requires both cloud pointers to move together", () => {
    expect(cloudFactsMatch(cloudFor(NEXT), NEXT)).toBe(true);
    expect(cloudFactsMatch({ release: { latest: NEXT.version, release_url: "other" } }, NEXT)).toBe(false);
    expect(cloudFactsMatch({ release: { latest: "1.0.0", release_url: NEXT.url } }, NEXT)).toBe(false);
    expect(cloudFactsMatch({}, NEXT)).toBe(false);
  });
});
