/**
 * Backend values that used to be accepted but whose implementations were
 * removed. Config parsers check against these so an old configuration fails
 * fast with an actionable message instead of silently falling back to a
 * different backend.
 */

/** Removed data-plane (DB) kinds: the hosted vector-database backend. */
export const REMOVED_DB_KINDS: readonly string[] = ["vdb"];

/** Removed file-plane kinds: the hosted object-storage backend. */
export const REMOVED_FS_KINDS: readonly string[] = ["cos"];

/**
 * Build the error thrown when a config key still names a removed backend.
 *
 * @param setting   the config surface that carried the value, e.g. `STORE_MODE` or `storeBackend`
 * @param value     the removed value as supplied
 * @param dimension `db` → suggest sqlite/mongodb; `fs` → suggest local/rowfs(+mongofs)
 * @param supported optional override of the suggested replacement values
 */
export function removedBackendError(
  setting: string,
  value: string,
  dimension: "db" | "fs",
  supported?: string,
): Error {
  supported ??= dimension === "db"
    ? `"sqlite" (default) or "mongodb"`
    : `"local" (default) or "rowfs" (with FILE_STORE_OTHERS="local" | "mongofs")`;
  const what = dimension === "db" ? "hosted vector-database backend" : "hosted object-storage backend";
  return new Error(
    `${setting}=${JSON.stringify(value)} is no longer supported: the ${what} has been removed. ` +
      `Use ${supported} instead.`,
  );
}
