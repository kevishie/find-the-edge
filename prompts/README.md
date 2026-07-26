# Prompt Infrastructure

Runtime scout prompts compose, in order:

1. Shared rules
2. Registered sport rules
3. Active strategy version
4. Requested analysis type
5. Structured event data outside the instruction text

`packages/scouting` validates the required sections and records the exact bundle and model version. Prompt prose never owns authoritative betting calculations.
