import type { GoalSessionRecord } from '../persistence/runLedger.js';
import { isValidNativeSessionId } from '../utils/conversationStore.js';
import type { ProviderExecutionResult } from './executor.js';

export class NativeSessionError extends Error {
  constructor(
    readonly reason: 'native_session_missing' | 'native_session_changed',
    message: string,
  ) {
    super(message);
    this.name = 'NativeSessionError';
  }
}

export function validateGoalNativeSession(
  session: GoalSessionRecord,
  result: ProviderExecutionResult,
): string {
  if (!result.sessionId || !isValidNativeSessionId(result.sessionId)) {
    throw new NativeSessionError(
      'native_session_missing',
      `The ${session.provider} CLI did not return a resumable native session id`,
    );
  }
  if (session.nativeSessionId && result.sessionId !== session.nativeSessionId) {
    throw new NativeSessionError(
      'native_session_changed',
      `The ${session.provider} CLI returned a different native session id; refusing to replace the durable pin`,
    );
  }
  return result.sessionId;
}
