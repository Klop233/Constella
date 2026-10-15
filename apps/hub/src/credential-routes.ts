import type { Hub } from "./app.ts";
import { z } from "zod";

/** Registered after the shared REST auth/CSRF hooks. No route returns a secret field value. */
export function registerCredentialRoutes(hub: Hub): void {
  const { app, credentials } = hub;
  const base = "/api/credentials";
  const params = z.object({ id: z.string().min(1).max(100) });
  app.get(base, async () => credentials.overview());
  app.put(`${base}/settings`, async req => {
    const b = z.object({ approverAgentId: z.string().max(100).nullable() }).parse(req.body);
    credentials.setApprover(b.approverAgentId, req.userId!); return { approverAgentId: credentials.approver() };
  });
  app.post(`${base}/connections`, async req => credentials.create(req.body,req.userId!));
  app.delete(`${base}/connections/:id`, async req => { credentials.remove(params.parse(req.params).id,req.userId!); return { ok: true }; });
  app.post(`${base}/connections/:id/unlock`, { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async req => {
    const b = z.object({ password: z.string().min(1).max(10000) }).parse(req.body);
    return credentials.unlock(params.parse(req.params).id,b.password,req.userId!);
  });
  app.post(`${base}/connections/:id/lock`, async req => { credentials.lock(params.parse(req.params).id,req.userId!); return { ok: true }; });
  app.post(`${base}/connections/:id/sync`, async req => credentials.sync(params.parse(req.params).id,req.userId!));
  app.get(`${base}/connections/:id/items`, async req => credentials.items(params.parse(req.params).id,z.object({ search: z.string().max(300).default("") }).parse(req.query).search));
  app.post(`${base}/requests/:id/decision`, async req => {
    const b = z.object({ decision: z.enum(["approve","deny"]), reason: z.string().max(1000).default("") }).parse(req.body);
    return credentials.decide(params.parse(req.params).id,b.decision,b.reason,req.userId!);
  });
  app.post(`${base}/requests/:id/revoke`, async req => credentials.revoke(params.parse(req.params).id,req.userId!));
}
