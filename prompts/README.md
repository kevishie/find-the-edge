# Prompt Infrastructure

Runtime scout prompts compose, in order:

1. Shared rules
2. Registered sport rules
3. Active strategy version
4. Requested analysis type
5. Structured event data outside the instruction text

`packages/scouting` validates the required sections and records the exact bundle and model version. Prompt prose never owns authoritative betting calculations.

Analysis bundles require exactly one section of every kind. Section text is normalized and hashed separately from canonical event evidence. Evidence is sorted by stable ID, encoded as canonical JSON, and placed in a UTF-8-length-prefixed untrusted frame. Callers must pass the returned structured messages separately: trusted instructions in the system message and the untrusted evidence frame in its own user message. Length framing preserves deterministic boundaries and hashes; it is not a claim that delimiters embedded in a combined message are behaviorally immune to prompt injection. The analysis contract versions the sport policy, prompt sections, input schema, output schema, and model reference together.
