// The warm-then-commit dance shared by every managed GPU scene (layers, overlay, marker): warm the
// prospective composite's pipelines off the render path (createRenderPipelineAsync), swallowing a warm
// failure so it never blocks the commit — the paint falls back to a sync compile. An epoch guard makes
// the async warm superseding: a newer replace/remove (or a device rebuild) bumps the id's epoch
// mid-warm, so this scene is stale and must be discarded rather than committed.
//
// Returns true when the caller should commit `next`, false when it was superseded (disposed here). A
// `next` of undefined is a teardown (overlay/marker cleared) — there's nothing to warm, so it always
// commits. The divergent commit (deferred vs same-tick dispose, source retention, marker re-seed) is
// the caller's, kept inline and visible.
export async function warmScene<T>(
  next: T | undefined,
  warm: () => Promise<unknown> | undefined,
  isCurrent: () => boolean,
  disposeNext: (next: T) => void,
  onWarmError: (error: unknown) => void,
): Promise<boolean> {
  if (next === undefined) return true;
  try {
    await warm();
  } catch (error) {
    onWarmError(error);
  }
  if (!isCurrent()) {
    disposeNext(next); // superseded mid-warm — discard rather than resurrect a stale scene
    return false;
  }
  return true;
}
