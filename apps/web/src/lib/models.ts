import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Effort } from "./types";

/** A model bound to a provider, referenced as "model@provider" (built-in new-api models by their bare name). */
export interface ModelEntry {
  ref: string;
  model: string;
  provider: string;
  providerName: string;
  /** "model (provider)", or just "model" for the entry of a name marked to omit the provider. */
  label: string;
  bare: boolean;
  test: { ok: boolean; ms: number | null; error: string | null; at: string } | null;
  /** Reasoning levels the model supports, weakest first (empty: not adjustable). */
  efforts: Effort[];
  defaultEffort: Effort | null;
}

/** "responses": Codex calls it directly; "chat": Chat Completions, bridged by the hub. */
export type ProviderApi = "responses" | "chat";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  api: ProviderApi;
  builtin: boolean;
  keyHint: string | null;
  models: number;
}

export function useModels() {
  return useQuery({ queryKey: ["models"], queryFn: () => api.get<ModelEntry[]>("/api/models"), staleTime: 300_000 });
}

export function useProviders() {
  return useQuery({ queryKey: ["providers"], queryFn: () => api.get<Provider[]>("/api/providers"), staleTime: 300_000 });
}

/** Splits a ref like the hub does: a provider id after the last "@", otherwise a bare new-api model. */
export function parseRef(ref: string): { model: string; provider: string } {
  const at = ref.lastIndexOf("@");
  const provider = at > 0 ? ref.slice(at + 1) : "";
  return provider === "newapi" || /^p-[a-z0-9-]+$/.test(provider) ? { model: ref.slice(0, at), provider } : { model: ref, provider: "newapi" };
}

/** Display name for any model ref, including ones no longer in the model list. */
export function useModelLabel(): (ref: string | null | undefined) => string {
  const models = useModels();
  const providers = useProviders();
  return (ref) => {
    if (!ref) return "";
    const p = parseRef(ref);
    const hit = models.data?.find((m) => m.model === p.model && m.provider === p.provider);
    if (hit) return hit.label;
    const name = providers.data?.find((x) => x.id === p.provider)?.name ?? (p.provider === "newapi" ? "new-api" : p.provider);
    return `${p.model} (${name})`;
  };
}
