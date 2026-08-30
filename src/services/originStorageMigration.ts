import { Migration } from "@apps-in-toss/web-framework";

const APP_STORAGE_KEY_PREFIX = "summer-vacation-diary:";
const MIGRATION_STORAGE_KEY =
  "summer-vacation-diary:origin-storage-migration:v1";

function hasLocalStorageError(
  errors: Array<{ storage: string; message: string }>,
): boolean {
  return errors.some(({ storage }) => storage === "localStorage");
}

/**
 * Recovers app-owned localStorage values written by an SDK 3.0/3.1.0 bundle.
 *
 * SDK 3.1.1 serves the SDK 2.x `apps.tossmini.com` Origin again. The migration
 * bridge exposes the short-lived `web.tossmini.com` Origin as `previous` and
 * the active Origin as `current`. Current values always win so an older draft,
 * client id, quota snapshot, or progress record can never overwrite newer data.
 * Toss Storage is Origin-independent and deliberately stays outside this flow.
 */
export async function migrateOriginLocalStorage(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATION_STORAGE_KEY) === "complete") {
      return;
    }

    const { previous, current } = await Migration.getOriginStorage();
    if (
      hasLocalStorageError(previous.errors) ||
      hasLocalStorageError(current.errors)
    ) {
      return;
    }

    let allValuesCopied = true;
    for (const [key, previousValue] of Object.entries(previous.localStorage)) {
      if (
        !key.startsWith(APP_STORAGE_KEY_PREFIX) ||
        key === MIGRATION_STORAGE_KEY ||
        previousValue === null ||
        current.localStorage[key] != null ||
        localStorage.getItem(key) !== null
      ) {
        continue;
      }

      try {
        localStorage.setItem(key, previousValue);
      } catch {
        allValuesCopied = false;
      }
    }

    if (allValuesCopied) {
      localStorage.setItem(MIGRATION_STORAGE_KEY, "complete");
    }
  } catch (error) {
    // A plain browser or an older Toss host may reject the migration bridge
    // call. Storage recovery is best effort and must never crash the app.
    console.warn("Origin localStorage migration was skipped", error);
  }
}
