// The warm-then-commit dance shared by every managed GPU scene (layers, overlay, marker): warm the
// prospective composite's pipelines off the render path (createRenderPipelineAsync), swallowing a warm
// failure so it never blocks the commit — the paint falls back to a sync compile. An epoch guard makes
// the async warm superseding: a newer replace/remove (or a device rebuild) bumps the id's epoch
// mid-warm, so this scene is stale and gets discarded. Returns true when the caller should commit
// `next`; an undefined `next` is a teardown, with nothing to warm, so it always commits.
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
