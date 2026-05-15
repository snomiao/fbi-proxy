export type OAuthFlowState = {
  codeVerifier: string;
  nonce: string;
  rd: string;
  createdAt: number;
};

const STATE_TTL_MS = 10 * 60 * 1000;

export type StateStore = {
  put(state: string, value: OAuthFlowState): void;
  take(state: string): OAuthFlowState | null;
  size(): number;
};

export function makeStateStore(): StateStore {
  const map = new Map<string, OAuthFlowState>();

  const gc = setInterval(() => {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [k, v] of map) if (v.createdAt < cutoff) map.delete(k);
  }, 60_000);
  gc.unref?.();

  return {
    put(state, value) {
      map.set(state, value);
    },
    take(state) {
      const v = map.get(state);
      if (!v) return null;
      map.delete(state);
      if (Date.now() - v.createdAt > STATE_TTL_MS) return null;
      return v;
    },
    size() {
      return map.size;
    },
  };
}
