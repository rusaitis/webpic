// Which clock produced a frame-timing sample. The render worker's frameTimer labels its samples, the
// wire carries the label, and the store's timing slice relays it to the UI — so the union lives where
// all three can see it. Today only wall-clock is produced (render-pass timestamp-query lost the Metal
// device); the UI keeps both labels so a restored GPU clock is additive, not a rename.
export type FrameClock = "timestamp" | "wallclock";
