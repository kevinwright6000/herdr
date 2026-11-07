import type { Response } from 'express';

export interface ProjectEvent {
  type: string;
  actorId?: string;
}

/** Fan-out of "something changed" pings to clients watching a project (Server-Sent Events). */
export class EventHub {
  private clients = new Map<string, Set<Response>>();

  subscribe(projectId: string, res: Response): () => void {
    let set = this.clients.get(projectId);
    if (!set) {
      set = new Set();
      this.clients.set(projectId, set);
    }
    set.add(res);
    return () => {
      set.delete(res);
      if (set.size === 0) this.clients.delete(projectId);
    };
  }

  emit(projectId: string, event: ProjectEvent): void {
    for (const res of this.clients.get(projectId) ?? []) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
}
