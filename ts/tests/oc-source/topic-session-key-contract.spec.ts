/**
 * Contract spec: oc-topic-manager session keys conform to OC's session-key
 * grammar.
 *
 * @why
 * tests/plugins/oc-topic-manager asserts `sessionKeyFor` output against a
 * hardcoded string IN THIS REPO — self-referential, so it stays green even if
 * OC changes its key grammar and every recovery plan silently writes keys OC
 * ignores. This spec pins the contract against OC's own parsers, imported from
 * the oc-source submodule (same dynamic-import pattern as hook-trace.spec.ts).
 *
 * Three layers of OC's real grammar are exercised — all pure, zero mocks:
 *
 * 1. `parseAgentSessionKey` (src/sessions/session-key-utils.ts) — the key must
 *    be a well-formed agent-namespaced session key whose `rest` is
 *    `telegram:group:<chatId>:topic:<topicId>`.
 * 2. `parseSessionDeliveryRoute` (same file) — OC must classify the key as a
 *    routable telegram GROUP session (this is what keeps topics out of the
 *    agent's main session — the registration-loss failure mode).
 * 3. `parseTelegramTopicConversation` (extensions/telegram/src/
 *    topic-conversation.ts — the zero-dep grammar module the bundled telegram
 *    plugin ships as its sessionKey hook) — the `<chatId>:topic:<topicId>`
 *    peer id must parse back to the exact chat and topic ids.
 *
 * NOTE on `parseSessionThreadInfo` (the generic resolver): with no channel
 * plugins loaded it intentionally does NOT extract `:topic:` suffixes —
 * topic extraction is plugin-owned (verified empirically; OC's own
 * delivery-info.test.ts passes because the telegram hook is loaded there).
 * We therefore assert the generic resolver's real fallback behavior, and pin
 * topic extraction against the plugin-owned grammar module instead.
 *
 * @dft
 * - Pure string parsing on both sides; no I/O, no clock, no random.
 * - Deterministic; runs in <5ms.
 * - Negative-control scenario proves this spec detects grammar drift.
 */

import { describe, it, expect } from "vitest"
import { sessionKeyFor } from "../../src/plugins/oc-topic-manager/src/recovery-plan.js"

const OC_SRC = "../../../oc-source/upstream/src"

// The real forum from the topic-registration-loss war story.
const CHAT_ID = "-1003842172831"
const WAR_STORY_TOPICS = [82385, 73239, 73336]

describe("Feature: oc-topic-manager session keys conform to OC's key grammar", () => {
  it("Scenario: keys parse as well-formed agent-namespaced session keys", async () => {
    const { parseAgentSessionKey } = await import(`${OC_SRC}/sessions/session-key-utils.js`)

    for (const topicId of WAR_STORY_TOPICS) {
      const key = sessionKeyFor("main", CHAT_ID, topicId)
      expect(parseAgentSessionKey(key)).toEqual({
        agentId: "main",
        rest: `telegram:group:${CHAT_ID}:topic:${topicId}`,
      })
    }
  })

  it("Scenario: OC classifies keys as routable telegram group sessions", async () => {
    const { parseSessionDeliveryRoute } = await import(`${OC_SRC}/sessions/session-key-utils.js`)

    for (const topicId of WAR_STORY_TOPICS) {
      const route = parseSessionDeliveryRoute(sessionKeyFor("main", CHAT_ID, topicId))
      // peerId keeps the full opaque tail including the :topic: suffix —
      // group-session isolation depends on it surviving normalization.
      expect(route).toMatchObject({
        channel: "telegram",
        peerKind: "group",
        peerId: `${CHAT_ID}:topic:${topicId}`,
      })
    }
  })

  it("Scenario: the telegram plugin grammar extracts the exact chat and topic ids", async () => {
    const { parseTelegramTopicConversation } = await import(
      "../../../oc-source/upstream/extensions/telegram/src/topic-conversation.js"
    )

    for (const topicId of WAR_STORY_TOPICS) {
      const parsed = parseTelegramTopicConversation({
        conversationId: `${CHAT_ID}:topic:${topicId}`,
      })
      expect(parsed).toEqual({
        chatId: CHAT_ID,
        topicId: String(topicId),
        canonicalConversationId: `${CHAT_ID}:topic:${topicId}`,
      })
    }
  })

  it("Scenario: generic thread resolver preserves the key (topic extraction is plugin-owned)", async () => {
    const { parseSessionThreadInfo } = await import(`${OC_SRC}/config/sessions/thread-info.js`)

    const key = sessionKeyFor("main", CHAT_ID, 82385)
    // Without a loaded telegram hook, the generic resolver returns the key
    // unchanged and no threadId — it must never MANGLE a topic key.
    expect(parseSessionThreadInfo(key)).toEqual({
      baseSessionKey: key,
      threadId: undefined,
    })
  })

  it("Scenario: keys survive round-trip through the full OC pipeline shape", async () => {
    // End-to-end composition: key → agent parse → plugin topic grammar,
    // for a non-default agent (the multi-agent collision case).
    const { parseAgentSessionKey } = await import(`${OC_SRC}/sessions/session-key-utils.js`)
    const { parseTelegramTopicConversation } = await import(
      "../../../oc-source/upstream/extensions/telegram/src/topic-conversation.js"
    )

    const key = sessionKeyFor("research", CHAT_ID, 82385)
    const agent = parseAgentSessionKey(key)!
    expect(agent.agentId).toBe("research")
    const [, kind, ...peerParts] = agent.rest.split(":")
    expect(kind).toBe("group")
    const parsed = parseTelegramTopicConversation({ conversationId: peerParts.join(":") })!
    expect(parsed.chatId).toBe(CHAT_ID)
    expect(parsed.topicId).toBe("82385")
  })

  it("Scenario: negative control — a malformed key FAILS the contract", async () => {
    // Proves this spec detects drift: a legacy-style key (no :group:/:topic:
    // segments) must not satisfy the contract.
    const { parseAgentSessionKey, parseSessionDeliveryRoute } = await import(
      `${OC_SRC}/sessions/session-key-utils.js`
    )
    const { parseTelegramTopicConversation } = await import(
      "../../../oc-source/upstream/extensions/telegram/src/topic-conversation.js"
    )

    const malformed = `agent:main:telegram:${CHAT_ID}:${82385}`
    const parsedAgent = parseAgentSessionKey(malformed)!
    expect(parsedAgent.rest).not.toMatch(/^telegram:group:/)
    expect(parseSessionDeliveryRoute(malformed)).toBeNull()
    expect(parseTelegramTopicConversation({ conversationId: `${CHAT_ID}:${82385}` })).toBeNull()
  })
})
