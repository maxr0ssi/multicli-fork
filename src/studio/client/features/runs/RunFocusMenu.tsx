import type { StudioRunView } from '../../types.js';
import { runFocusItems, type RunFocus } from './focusModel.js';

interface RunFocusMenuProps {
  readonly view: StudioRunView;
  readonly onOpen: (focus: RunFocus) => void;
}

export function RunFocusMenu({ view, onOpen }: RunFocusMenuProps) {
  return (
    <nav class="run-focus-menu" aria-label="Run views">
      {runFocusItems(view).map(item => (
        <button
          type="button"
          class="run-focus-button"
          data-state={item.state}
          onClick={() => onOpen(item.id)}
          key={item.id}
        >
          <strong>{item.label}</strong>
          <span>{item.detail}</span>
        </button>
      ))}
    </nav>
  );
}
