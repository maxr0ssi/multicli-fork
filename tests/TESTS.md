# Live MCP checks

These checks use real CLIs and provider quota. They supplement `npm test`; run
them when verifying an installation. Record PASS, FAIL, or SKIP with evidence.
Skip providers or protocol operations the connected client does not expose.

1. Inspect the server's tool list. Installed providers expose `Ask-*`,
   `List-*-Models`, and `*-Help`. Recognized clients hide their own provider;
   an absent provider can also mean its CLI is missing.
2. Call the visible model-list and help tools. Use returned model IDs and the
   exact tool names your host exposes.
3. If raw protocol calls are available, verify missing/empty `prompt` or `model`,
   invalid access modes, and unknown or filtered tools fail without execution.
4. Ask each visible Claude/Codex provider to report its working directory and
   reply with `MULTICLI_TEST_OK`, without changing files. Omit `conversationId`.
   Check the directory, response, and returned conversation handle.
5. Reuse that handle with the same model and access mode. Ask for the earlier
   marker without repeating it. Check the answer and incremented turn count.
6. Use `conversationId: "none"` for a reply without a handle, and `"new"` for
   a different handle. Changed model/access on the original handle must reject
   before execution. Concurrent turns on one handle must also reject.
7. If two providers are visible, send independent read-only calls concurrently
   and verify their responses remain separate.
8. For Antigravity/OpenCode, verify a read-only marker response. If Antigravity
   change mode returns a cache key, fetch a valid one-based chunk and check that
   invalid keys/indices fail cleanly. Otherwise skip chunk retrieval.

Report client/provider versions, results, failures, and skipped prerequisites.
A missing native-session warning counts as a persistence failure. Do not record
credentials or private prompt/reply bodies in the report.
