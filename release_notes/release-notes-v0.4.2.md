# Release Notes — v0.4.2

## Highlights

MDium now talks to opencode through the **opencode SDK v2 client** (`@opencode-ai/sdk` 1.19.5). The chat panel, the workflow adapter, MCP sync, `@` file completion and the commit-message generator all use the v2 API, which matches what current opencode servers send and reply to. No user-visible behavior changes.

---

## Changes

### opencode SDK v2

- Bumped `@opencode-ai/sdk` from 1.17.13 to 1.19.5 and moved every call from the v1 entry point (`@opencode-ai/sdk/client`) to `@opencode-ai/sdk/v2/client`
- Workflow stages answer opencode permission requests (`permission.asked`) through the v2 reply route; the `permission.updated` requests of older servers still use the previous route, so older opencode versions keep working
- The chat panel replies to and dismisses opencode questions through the SDK (`question.reply` / `question.reject`) instead of hand-built requests
- The workflow adapter's client interface is checked against the real v2 client at build time

---

## Chores & Docs

- Verified against opencode 1.19.5: every API call MDium makes, a full workflow turn including a permission request, and a question round trip in the chat flow
