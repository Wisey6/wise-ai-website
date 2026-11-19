// Owner-only diagnostics: what the chat's input tokens are made of (count_tokens is free).
import Anthropic from "npm:@anthropic-ai/sdk@0";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export type ProfileParts = { system: string; tools: Row[]; context: string; history: Row[]; variants?: Record<string, { system: string; tools: Row[]; extra?: Row[] }> };

/** Token counts per part, for one model: system alone, + tools, + context block, + history. */
export async function tokenProfile(model: string, p: ProfileParts): Promise<Row> {
  const c = new Anthropic({ maxRetries: 1, timeout: 30_000 });
  // deno-lint-ignore no-explicit-any
  const count = async (body: Row) => (await c.messages.countTokens({ model, ...body } as any)).input_tokens as number;
  const hi = [{ role: "user", content: "hi" }];
  const out: Row = { model };
  out.message_hi = await count({ messages: hi });
  out.system = (await count({ system: p.system, messages: hi })) - out.message_hi;
  out.tools = (await count({ system: p.system, tools: p.tools, messages: hi })) - out.system - out.message_hi;
  out.context = (await count({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: p.context }] }] })) - out.message_hi;
  out.history = p.history.length ? (await count({ messages: [...p.history, ...hi] })) - out.message_hi : 0;
  for (const [name, v] of Object.entries(p.variants ?? {})) {
    try {
      out[`variant_${name}`] = await count({ system: v.system, tools: v.tools, messages: [...hi, ...(v.extra ?? [])] }) - out.message_hi;
    } catch (e) {
      out[`variant_${name}`] = `error: ${(e as Error).message.slice(0, 200)}`;
    }
  }
  return out;
}
