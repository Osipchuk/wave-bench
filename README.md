# wave-bench

One prompt, four Claude models, one pass each: build an interactive **3D coastal flood / tsunami simulation** in the browser.

The prompt ([PROMPT.md](PROMPT.md)) asks for a real-time shallow-water solver that interacts with terrain, user-placed
defenses and buildings, with erosion, damage, flow visualization and a reliable reset loop. It is explicitly a
**one-shot benchmark**: no retries, no follow-up fixes. Each folder is the model's output as it was left, unedited.

| Folder | Model | Effort | Active time | Output tokens | Est. cost | Run |
| --- | --- | --- | --- | --- | --- | --- |
| [`fable5.1/`](fable5.1) | Claude Fable 5.1 | medium | 41 min | 173K | $14.41 | `npx -y http-server -p 8123 -c-1 .` |
| [`opus5.5/`](opus5.5) | Claude Opus 5.5 | medium | 72 min | 260K | $14.90 | `npm start` (port 5173) |
| [`sonnet5/`](sonnet5) | Claude Sonnet 5 | high | 38 min | 157K | $10.27 | `node server.js` (port 8420) |
| [`sonnet5.5/`](sonnet5.5) | Claude Sonnet 5.5 | high | 38 min | 216K | $8.77 | open `index.html` / `coastal-flood-lab.html` |

Full numbers (input / cache tokens, wall-clock time) are in [results.json](results.json).
Cost is estimated from the session transcripts at list API prices; cache reads dominate the token totals in agentic runs.

## Notes on the runs

- Same prompt, same harness (Claude Code), one session per model.
- The Fable 5.1 session hit the output-token limit once and was told to resume; the Sonnet 5.5 session received
  some background-monitor notifications. Neither run got any additional guidance.
- Time is "active" time (gaps over 5 minutes are dropped).

## Side-by-side comparison

`videos/` holds the identical scripted scenario recorded on all four builds and the 2x2 comparison video
(see [videos/README.md](videos/README.md)).
