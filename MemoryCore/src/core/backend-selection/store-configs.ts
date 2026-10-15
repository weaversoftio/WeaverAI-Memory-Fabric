/**
 * Bridge from the selection layer to the existing StorePool call shape.
 *
 * StorePool.getStore takes `(instanceId, mongoConfig)` and infers the kind
 * from config presence; because a validated {@link DbChoice} always carries
 * exactly the conn its kind requires, the pool's inference necessarily agrees
 * with the explicit kind.
 */

import type { MongoConfig } from "../instance-config-provider.js";
import type { DbChoice } from "./types.js";

export interface StoreBackendConfigs {
  mongoConfig: MongoConfig | null;
}

export function dbChoiceToStoreConfigs(db: DbChoice): StoreBackendConfigs {
  switch (db.kind) {
    case "mongodb":
      return { mongoConfig: db.conn };
    case "sqlite":
      return { mongoConfig: null };
  }
}
