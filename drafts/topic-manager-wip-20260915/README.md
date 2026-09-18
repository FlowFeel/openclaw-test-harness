# topic-manager WIP (parked 2026-09-15 session)

Untracked files recovered from the Sep 15 session that died during
compaction. In-flight work for topic-manager v2: server-side topic
ingestion via molton (telethon-client, registry-client, sync-plan).

**State:** tests fail (2 spec mismatches in normalizeForumTopic and
buildTopicsUrl cursor params; registry-client null-guard missing on
`Object.keys(sessions)` for undefined input).

**Not committed to main** — main at 8bc4158 does not contain these.
Parked here 2026-09-18 by Flow so local vitest runs stay clean and the
work is not lost. Resume by moving files back into
`ts/src/plugins/oc-topic-manager/` and `ts/tests/plugins/oc-topic-manager/`
and fixing the 3 failing cases before opening a PR.
