# pi AGENTS.md (local)

This repo is the canonical, self-contained pi home.

## Source of truth
The full agent contract/instructions live in:

- `~/.pi/agent/operation-mindfuck/*.lisp`

They are automatically appended to the system prompt by:

- `~/.pi/agent/extensions/opencode-global-instructions.ts`
  (configured in `~/.pi/agent/settings.json`)

## Hard constraints

- **Containers never run as root.** Every Dockerfile must have a `USER` directive after privileged `RUN` steps. Every docker-compose service using a plain image must have `user: "${DOCKER_USER:-1000:1000}"`. Database images are the sole exception. Init containers may use `user: "0:0"` with a comment.
- **Commit all work at the end of every turn.** If you created or modified files, `git add` the changed paths (never `git add -A` in a shared workspace) and commit before the turn ends. Use a descriptive commit message.

## Local addenda
- Canonical runtime skills live in `~/.pi/agent/skills`.
- The absorbed legacy `opencode-skills` repo lives in `~/.pi/collections/opencode-skills`.
- When working in `~/devel`, treat it as the workspace root that other machines might call `~/projects` or `~/repos`; use `devel-workspace-contract` to map path intent into the placement contract.
- When the user says `engage in total creative freedom`, use `total-creative-freedom` to widen the search/solution space without drifting from intent.
- When the user says `sing the songs of your people`, use `sing-the-songs-of-your-people` to mine notes/session lore and return a beautiful but truthful synthesis.
- When the user says `grok my intention`, `manifest the dream`, or similar dense-intent phrases, use `grok-intention` to recover latent intent from notes, sessions, and repo context, then manifest it into structure.
- Use `session-mycology` when you want quiet per-turn retrospection, p-score friction tracking, or incubation of reusable skill spores across sessions.
