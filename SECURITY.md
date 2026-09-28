# Security

This is an experimental local tool, not a hardened service. It runs installed
coding CLIs using your account, their authentication, and their permissions.
Those CLIs can contact their providers and may modify files when permitted.

- Keep HTTP and Studio on loopback. Never share bearer tokens or Studio launch links.
- Codex calls default to read-only. Check the workspace and permissions before allowing edits.
- Persistent sessions and workflows retain local data. Protect `~/.multicli`,
  workspace `.multicli` directories, custom stores, and provider transcripts.
- Default operational logs omit prompts and replies. Never commit runtime data or credentials.

Report vulnerabilities through [private reporting](https://github.com/maxr0ssi/multicli-fork/security/advisories/new)
if enabled. Otherwise, open an issue asking for private contact without exploit
details or secrets. There is no guaranteed response time or release schedule.
