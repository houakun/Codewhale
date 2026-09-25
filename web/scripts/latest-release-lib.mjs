/**
 * latest-release-lib.mjs — pure decision logic for sync-latest-release.mjs.
 *
 * Two historical failure modes in the sync script were ordering bugs, and both
 * are expressible as pure decisions:
 *
 *   1. A failed GitHub lookup exited 0 under `--check`, so an outage or a rate
 *      limit read as a green gate while the checked-in record could be
 *      arbitrarily stale.
 *   2. The target file was written before the mirrors were validated, so an
 *      unreadable mirror left the three mirrored facts inconsistent — exactly
 *      what public-surface-contract.test.ts and check-cloud-facts.mjs then
 *      report as red.
 *
 * Keeping the decisions here means the script can only read, decide, then
 * write, and the tests can pin both behaviours without a network or a
 * workspace tree. Pure and dependency-free, like changelog-lib.mjs.
 */

/** The four release fields mirrored across the three checked-in facts. */
export function releaseFactFromRelease(release, repo) {
  const tag = String(release?.tag_name || "");
  const version = tag.startsWith("v") ? tag.slice(1) : "";
  const publishedAt = String(release?.published_at || "");
  if (!tag || !version || tag !== `v${version}` || !Number.isFinite(Date.parse(publishedAt))) {
    return null;
  }
  return {
    tag,
    version,
    publishedAt,
    url: `https://github.com/${repo}/releases/tag/${tag}`,
  };
}

/** Whether a checked-in release fact already matches the published release. */
export function releaseFactMatches(fact, next) {
  return Boolean(fact) && fact.tag === next.tag && fact.publishedAt === next.publishedAt;
}

/** Whether cloud-facts `stable.json` already points at the published release. */
export function cloudFactsMatch(cloud, next) {
  return (
    Boolean(cloud?.release) &&
    cloud.release.latest === next.version &&
    cloud.release.release_url === next.url
  );
}

/**
 * Decide what the sync may do, before a single file is touched.
 *
 *   { kind: "refuse", reason } — a mirror is unreadable; writing anything now
 *                                would leave the three facts split.
 *   { kind: "current" }        — every mirror matches; nothing to do.
 *   { kind: "stale", ... }     — `--check` only: the record is behind.
 *   { kind: "write" }          — safe to update all three files.
 */
export function planReleaseSync({ current, matrix, cloud, next, checkOnly }) {
  if (!matrix) return { kind: "refuse", reason: "mirror-unreadable" };
  if (!cloud?.release) return { kind: "refuse", reason: "cloud-facts-unreadable" };

  const currentMirror = matrix.latestPublishedRelease ?? null;
  const targetOk = releaseFactMatches(current, next);
  const mirrorOk = releaseFactMatches(currentMirror, next);

  if (targetOk && mirrorOk && (checkOnly || cloudFactsMatch(cloud, next))) {
    return { kind: "current" };
  }

  if (checkOnly) {
    return {
      kind: "stale",
      staleTarget: !targetOk,
      staleMirror: !mirrorOk,
      // Only a target and mirror that agree with each other may use the 24h
      // grace window: a split record is never "just catching up".
      mirrorAgreesWithTarget: (current?.tag ?? null) === (currentMirror?.tag ?? null),
    };
  }

  return { kind: "write" };
}
