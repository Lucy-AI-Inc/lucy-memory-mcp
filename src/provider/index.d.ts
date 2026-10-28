export class LucyMemoryFirstProvider {
  constructor(options: { client: { recall(json: string): Promise<unknown>; propose(json: string): Promise<{ status: string }> } });
  beforeResponse(input: { prompt: string; scope: unknown }): Promise<{ recalled: boolean; context: string; reason: string; results?: unknown; canonical?: boolean }>;
  afterEvent(input: { event: Record<string, unknown>; scope: unknown }): Promise<{ proposed: boolean; reason: string; saved?: boolean; canonical?: boolean; code?: string | null; proposal?: unknown }>;
  readonly lucyUnavailable: boolean;
}
export function shouldRecall(prompt: string): boolean;
export function isDurableEvent(event: unknown): boolean;
export function formatRecallContext(recallResponse: { results?: Array<{ id: string; version: number; key: string; content: string }> }): string;
