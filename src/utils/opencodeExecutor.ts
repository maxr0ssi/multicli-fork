import { executeCommand } from './commandExecutor.js';
import { CLI } from '../constants.js';
import { ToolExecutionContext } from '../execution.js';

export async function executeOpencodeCLI(
  prompt: string,
  model: string,
  context?: ToolExecutionContext,
): Promise<string> {
  const args: string[] = [
    CLI.OPENCODE_SUBCOMMANDS.RUN,
    prompt,
    CLI.OPENCODE_FLAGS.MODEL, model,
  ];

  return executeCommand(CLI.COMMANDS.OPENCODE, args, context);
}
