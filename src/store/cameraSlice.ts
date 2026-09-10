import { DEFAULT_POSE } from "./camera.ts";
import type { CameraSlice, SliceContext } from "./state.ts";

// The orbit camera: pose, motion liveness, projection, fly mode, and one-shot fly requests.

export function createCameraSlice({ get, set }: SliceContext): CameraSlice {
  return {
    cameraPose: DEFAULT_POSE,
    cameraMotion: "idle",
    projection: "perspective",
    isFlyMode: false,
    cameraFlyRequest: null,
    setCameraPose(pose) {
      set({ cameraPose: pose }); // fresh object each call so subscribeWithSelector fires
    },
    setCameraMotion(motion) {
      if (motion === get().cameraMotion) return; // unchanged → no fire
      set({ cameraMotion: motion });
    },
    setProjection(projection) {
      if (projection === get().projection) return; // unchanged → no fire
      set({ projection });
    },
    setFlyMode(on) {
      if (on === get().isFlyMode) return; // unchanged → no fire
      set({ isFlyMode: on });
    },
    toggleFlyMode() {
      set({ isFlyMode: !get().isFlyMode });
    },
    requestCameraFly(target) {
      set({ cameraFlyRequest: target === null ? null : { target } });
    },
  };
}
