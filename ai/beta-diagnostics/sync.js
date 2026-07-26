export const DIAGNOSTICS_SYNC_CHANNEL = "sunland-beta-diagnostics-v1";
export const DIAGNOSTICS_SYNC_SCHEMA_VERSION = 1;

const MESSAGE_TYPES = new Set([
  "mode-changed",
  "snapshot-cleared",
  "snapshot-updated",
]);

function isValidMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === 2 &&
    keys.includes("schemaVersion") &&
    keys.includes("type") &&
    value.schemaVersion === DIAGNOSTICS_SYNC_SCHEMA_VERSION &&
    MESSAGE_TYPES.has(value.type)
  );
}

export function createBetaDiagnosticsSyncChannel({
  BroadcastChannelImpl = globalThis.BroadcastChannel,
} = {}) {
  let channel = null;
  let disposed = false;
  const listeners = new Set();

  try {
    if (typeof BroadcastChannelImpl === "function") {
      channel = new BroadcastChannelImpl(DIAGNOSTICS_SYNC_CHANNEL);
      channel.addEventListener("message", event => {
        if (disposed || !isValidMessage(event?.data)) return;
        for (const listener of listeners) {
          try {
            listener(event.data.type);
          } catch {
            // A diagnostics listener must never affect another listener.
          }
        }
      });
    }
  } catch {
    channel = null;
  }

  return Object.freeze({
    notify(type) {
      if (disposed || !channel || !MESSAGE_TYPES.has(type)) return false;
      try {
        channel.postMessage(Object.freeze({
          schemaVersion: DIAGNOSTICS_SYNC_SCHEMA_VERSION,
          type,
        }));
        return true;
      } catch {
        return false;
      }
    },

    subscribe(listener) {
      if (disposed || typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      if (disposed) return false;
      disposed = true;
      listeners.clear();
      try {
        channel?.close();
      } catch {
        // Best-effort only.
      }
      channel = null;
      return true;
    },
  });
}
