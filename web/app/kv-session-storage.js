/**
 * Custom Shopify session storage adapter for Cloudflare KV.
 * Uses a lazy KV binding that gets set per-request via setKV().
 */

import { Session } from "@shopify/shopify-api";

const SESSION_PREFIX = "shopify_session:";
const SHOP_INDEX_PREFIX = "shop_sessions:";

let _kv = null;

/**
 * Set the KV binding for the current request.
 * Must be called before any session operations.
 * @param {KVNamespace} kv
 */
export function setKV(kv) {
  _kv = kv;
}

function getKV() {
  if (!_kv) throw new Error("KV not initialized. Call setKV(env.SESSIONS) first.");
  return _kv;
}

export class KVSessionStorage {
  async storeSession(session) {
    const kv = getKV();
    const key = SESSION_PREFIX + session.id;
    const data = session.toObject ? session.toObject() : session;
    await kv.put(key, JSON.stringify(data));

    if (data.shop) {
      const indexKey = SHOP_INDEX_PREFIX + data.shop;
      const existing = await kv.get(indexKey, "json");
      const sessionIds = existing || [];
      if (!sessionIds.includes(session.id)) {
        sessionIds.push(session.id);
        await kv.put(indexKey, JSON.stringify(sessionIds));
      }
    }

    return true;
  }

  async loadSession(id) {
    const kv = getKV();
    const key = SESSION_PREFIX + id;
    const data = await kv.get(key, "json");
    if (!data) return undefined;
    return new Session(data);
  }

  async deleteSession(id) {
    const kv = getKV();
    const key = SESSION_PREFIX + id;
    const data = await kv.get(key, "json");

    if (data?.shop) {
      const indexKey = SHOP_INDEX_PREFIX + data.shop;
      const existing = await kv.get(indexKey, "json");
      if (existing) {
        const filtered = existing.filter((sid) => sid !== id);
        if (filtered.length > 0) {
          await kv.put(indexKey, JSON.stringify(filtered));
        } else {
          await kv.delete(indexKey);
        }
      }
    }

    await kv.delete(key);
    return true;
  }

  async deleteSessions(ids) {
    await Promise.all(ids.map((id) => this.deleteSession(id)));
    return true;
  }

  async findSessionsByShop(shop) {
    const kv = getKV();
    const indexKey = SHOP_INDEX_PREFIX + shop;
    const sessionIds = await kv.get(indexKey, "json");
    if (!sessionIds || sessionIds.length === 0) return [];

    const sessions = await Promise.all(
      sessionIds.map(async (id) => {
        const key = SESSION_PREFIX + id;
        const data = await kv.get(key, "json");
        if (!data) return null;
        return new Session(data);
      })
    );

    return sessions.filter(Boolean);
  }
}
