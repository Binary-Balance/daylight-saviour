---
status: accepted
---

# Make accessibility a release gate

Daylight Saviour will treat accessibility as part of MVP completion. Its core status, zone selection, Change Event explanation, reminder controls, and data-freshness state must remain understandable and operable with VoiceOver, TalkBack, operating-system text scaling, increased contrast, and reduced motion.

## Consequences

- Semantic roles, states, hints, headings, and focus order are designed with each component rather than added after visual completion.
- Accessibility labels communicate literal facts and actions; playful secondary copy is not required to understand or operate the app.
- Status and Change Event direction never depend on colour or animation alone.
- Layouts must tolerate enlarged text without truncating critical facts or hiding controls.
- Meaningful motion receives a reduced-motion equivalent; decorative motion can be removed entirely.
- Automated assertions cover semantics where practical, while release checks include manual VoiceOver and TalkBack smoke tests on both platforms.
- Critical accessibility regressions block store submission.
