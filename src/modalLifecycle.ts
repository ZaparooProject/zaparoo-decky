export interface ModalHandle {
  Close(): void;
}

type DismountCleanup = () => void | Promise<void>;

interface TrackedModal {
  handle: ModalHandle;
  onDismount: DismountCleanup | undefined;
}

const trackedModals = new Map<ModalHandle, TrackedModal>();
let dismounted = false;

function runDismountCleanup(onDismount: DismountCleanup | undefined): void {
  if (!onDismount) return;
  try {
    Promise.resolve(onDismount()).catch((error) =>
      console.error("Could not clean up Zaparoo modal during plugin unload", error),
    );
  } catch (error) {
    console.error("Could not clean up Zaparoo modal during plugin unload", error);
  }
}

export function startModalLifecycle(): void {
  dismounted = false;
}

export function isModalLifecycleActive(): boolean {
  return !dismounted;
}

export function registerModal<T extends ModalHandle>(
  handle: T,
  onDismount?: DismountCleanup,
): T {
  if (dismounted) {
    try {
      handle.Close();
    } finally {
      runDismountCleanup(onDismount);
    }
    throw new Error("Zaparoo plugin is unloading");
  }
  trackedModals.set(handle, { handle, onDismount });
  return handle;
}

export function closeModal(handle: ModalHandle): void {
  handle.Close();
  trackedModals.delete(handle);
}

export function closeAllModals(): void {
  dismounted = true;
  const active = [...trackedModals.values()];
  trackedModals.clear();
  for (const { handle, onDismount } of active) {
    try {
      handle.Close();
    } catch (error) {
      console.error("Could not close Zaparoo modal during plugin unload", error);
    }
    runDismountCleanup(onDismount);
  }
}
