// Runs the embedding model off the daemon's main thread so hooks are never blocked.
const scope = globalThis as any;

let fe: any;

async function load(cacheDir: string, model: string, dtype: string, threads: number) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;
  fe = await pipeline("feature-extraction", model, {
    dtype: dtype as any,
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
  } as any);
}

scope.onmessage = async (ev: MessageEvent) => {
  const { id, kind, texts, init } = ev.data;
  try {
    if (kind === "init") {
      await load(init.cacheDir, init.model, init.dtype, init.threads);
      scope.postMessage({ id, ok: true });
      return;
    }
    const out = await fe(texts, { pooling: "mean", normalize: true });
    const vecs: Float32Array[] = out.tolist().map((v: number[]) => Float32Array.from(v));
    scope.postMessage({ id, ok: true, vecs }, vecs.map((v) => v.buffer) as any);
  } catch (e: any) {
    scope.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
