import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

type CancelHandler = (reason?: string) => void;

export class ManagedTaskStore extends InMemoryTaskStore {
  private readonly cancelHandlers = new Map<string, CancelHandler>();

  registerCancelHandler(taskId: string, handler: CancelHandler) {
    this.cancelHandlers.set(taskId, handler);
  }

  clearCancelHandler(taskId: string) {
    this.cancelHandlers.delete(taskId);
  }

  override async updateTaskStatus(
    taskId: string,
    status: 'working' | 'completed' | 'failed' | 'cancelled' | 'input_required',
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);

    if (status === 'cancelled') {
      this.cancelHandlers.get(taskId)?.(statusMessage);
      this.cancelHandlers.delete(taskId);
      return;
    }

    if (status === 'completed' || status === 'failed') {
      this.cancelHandlers.delete(taskId);
    }
  }

  override async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Parameters<InMemoryTaskStore['storeTaskResult']>[2],
    sessionId?: string,
  ): Promise<void> {
    await super.storeTaskResult(taskId, status, result, sessionId);
    this.cancelHandlers.delete(taskId);
  }

  override cleanup(): void {
    this.cancelHandlers.clear();
    super.cleanup();
  }
}
