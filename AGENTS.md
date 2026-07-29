## Mandatory KB preflight

Before any boss-paegi investigation or work, read these local Knowledge Base sources first:

1. `/Users/user/KnowledgeBase/_meta/conventions.md`
2. `/Users/user/KnowledgeBase/personal/projects/boss-paegi.md`
3. Every task-relevant note in `/Users/user/KnowledgeBase/personal/projects/boss-paegi/`
4. For QA, security, operations, deployment, or runtime checks: `/Users/user/KnowledgeBase/personal/infra.md`, `boss-paegi/infra.md`, and `boss-paegi/known-non-issues.md`

For a service-wide QA request, read the complete boss-paegi note set before code/runtime testing. Do not wait for the user to remind you. Use the KB to identify `BOSS_PAEGI_*` variables in `~/.zshenv`; never print secret values. The local `.env.local` points at production services, so treat local browser actions as production-impacting until proven otherwise.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
