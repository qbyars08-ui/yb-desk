---
name: Research request
about: Task the research agent with one ticker. It replies on this issue in minutes.
title: "research: "
labels: research
---

One ticker per issue. Put it in the title, right after the prefix:

```
research: NVDA
```

That is the whole job. You can leave this body empty or add context below, the agent reads the title.

How it works:

- The research agent wakes up when this issue opens, pulls live data, and posts a full desk report as a comment on this issue, usually within a few minutes.
- Ticker format: letters, numbers, dots, dashes. `research: BRK.B` works.
- One ticker per issue. Want two names, open two issues.
- Requests from outside the desk need an `approved` label from the owner before the agent runs.

Not investment advice. Your money, your call.
