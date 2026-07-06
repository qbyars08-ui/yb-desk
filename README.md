# yb-desk

My book. Your desk. An agent office that runs itself on GitHub, for exactly $0 a month.

**Live dashboard: [qbyars08-ui.github.io/yb-desk](https://qbyars08-ui.github.io/yb-desk/)**

I'm Quinn. I run Young Bull, a real-money portfolio built around the Physical Layer of AI, the chips, power, networking, and photonics that the models actually run on. This repo is the desk behind it. The positions in `data/book.json` are real. The prices update themselves. The reports write themselves. Nobody is paying for a server anywhere.

## What lives here

- **The book.** Every position, thesis, variant perception, and kill vector, in one JSON file. No screenshots of a spreadsheet. The actual data.
- **The dashboard.** A terminal-style desk served free by GitHub Pages from `docs/`. Dark charcoal, gold tape, monospace numbers.
- **The agent office.** GitHub Actions is the payroll department. Three agents clock in on a schedule and commit their own work back to the repo.

## The agents

| Agent | Shift | Job |
|---|---|---|
| price agent | every 30 min during market hours | pulls quotes, refreshes the tape, commits `tape: price update` |
| watchdog | rides along with the price agent | checks positions against their kill vectors and flags anything bleeding |
| desk report | 5:30pm ET after the close | writes the daily desk report and files it in `data/reports/` |
| research agent | on demand | you open an issue, it researches the ticker and replies on the issue |

All of it runs on GitHub Actions crons. No VPS, no Vercel, no serverless bill. The repo is the database, the CI is the compute, the Pages site is the frontend. $0.

## Task the research agent

Open an issue titled:

```
research: NVDA
```

That's it. One ticker per issue. The agent parses the title, pulls live data, writes a structured report, and posts it back as a comment on your issue, usually within a few minutes. There's an issue template ready to go under **New issue, Research request**.

Requests from strangers wait for an `approved` label first, so the office doesn't get spammed into a rate limit.

## Fork it and run your own desk

The whole point of $0 architecture is that you can copy it. Fork this repo, then:

1. **Edit the book.** Replace the positions in `data/book.json` with yours.
2. **Turn on Pages.** Settings, Pages, deploy from branch, folder `/docs`. Your desk is now live at `your-username.github.io/yb-desk/`.
3. **Add one secret.** Settings, Secrets and variables, Actions, new secret named `GROQ_API_KEY` (free tier at groq.com). The research agent needs it. The price agent doesn't.
4. **Enable Actions.** Forks ship with workflows disabled. Flip them on in the Actions tab and the office starts its shifts.

## Local dev

Zero dependencies. Nothing to install, ever. Plain Node 20 built-ins and plain HTML, CSS, and JS.

```bash
# serve the dashboard
cd docs && python3 -m http.server 8080

# run any agent by hand
node agents/price-agent.mjs
node agents/desk-report.mjs
TICKER=NVDA node agents/research-agent.mjs
```

## Privacy

The dashboard has a spot where visitors can look at their own portfolio next to mine. That data never leaves the browser. No analytics, no tracking, no backend to send it to, because there is no backend.

## License

MIT. See [LICENSE](LICENSE). Take the code, build your own desk, make it better.

---

Not investment advice. Your money, your call.
