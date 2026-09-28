import type {
  StudioRunAction,
  StudioRunView,
} from './types.js';

const VALID_ACTIONS: Readonly<Record<StudioRunAction, readonly string[]>> = {
  pause: ['running'],
  resume: ['waiting'],
  cancel: ['queued', 'running', 'waiting'],
};

export function visibleRunActions(view: StudioRunView): StudioRunAction[] {
  return (Object.keys(VALID_ACTIONS) as StudioRunAction[]).filter(action => (
    view.run.allowedActions[action].allowed
    && VALID_ACTIONS[action].includes(view.run.status)
  ));
}
