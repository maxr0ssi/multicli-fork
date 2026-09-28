import { useState } from 'preact/hooks';

import type { StudioActionAvailability, StudioWorkflowProfile } from '../../types.js';

interface OpenGoalSessionProps {
  readonly availability: StudioActionAvailability;
  readonly profile: StudioWorkflowProfile;
  readonly onOpen: (goal: string) => Promise<void>;
}

export function OpenGoalSession({ availability, profile, onOpen }: OpenGoalSessionProps) {
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!availability.allowed) return null;

  return (
    <section class="inspector-section" aria-labelledby="open-goal-session-title">
      <h3 id="open-goal-session-title">Start a steerable continuation</h3>
      <p>
        Continue with a durable {profile.model} CLI conversation using this exact profile. This
        does not interrupt or rewrite the current one-shot attempt or its workflow result.
      </p>
      <form onSubmit={event => {
        event.preventDefault();
        const value = goal.trim();
        if (!value) return;
        setBusy(true);
        setError(undefined);
        void onOpen(value)
          .then(() => setGoal(''))
          .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setBusy(false));
      }}>
        <label class="form-field">
          <span>Session goal</span>
          <textarea
            required
            maxLength={8000}
            value={goal}
            onInput={event => setGoal(event.currentTarget.value)}
          />
        </label>
        {error && <p class="action-error" role="alert">{error}</p>}
        <button class="button button-primary" type="submit" disabled={busy || !goal.trim()}>
          {busy ? 'Opening…' : 'Start continuation'}
        </button>
      </form>
    </section>
  );
}
