export type SlashCommandInvocation = {
  command: string;
  args: string;
};

// Split a slash-command line without treating ordinary prompts or absolute
// paths as commands. Known-command validation remains with the dispatcher.
export function parseSlashCommandInvocation(input: string): SlashCommandInvocation | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const separator = trimmed.search(/\s/);
  if (separator === -1) {
    return { command: trimmed.toLowerCase(), args: "" };
  }
  return {
    command: trimmed.slice(0, separator).toLowerCase(),
    args: trimmed.slice(separator).trim(),
  };
}
