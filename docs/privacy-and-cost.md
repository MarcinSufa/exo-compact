# Privacy and cost

exo-compact does not make a model call when it compacts a session. A few optional background
features do make calls. This page lists everything that leaves the machine, everything written
to disk, and what each feature costs.

## What leaves the machine

| Path | Enabled by | Sent | To |
|---|---|---|---|
| The seed and kept tail | always, at a cut | the new context of the session | Anthropic, like any message in the session |
| Task card refresh | `taskCard` (default on) | a background fork of the session, asked to rewrite the card | Anthropic, through Claude Code's `$.model.fork` |
| Brief checklist | `briefDigestModel` (default `"sonnet"`), only with `taskCard=false` | the saved brief text | Anthropic, through `claude -p --model <alias>` |
| Vector runtime install | `recallVectors` (default on), on first use | an npm install of `@huggingface/transformers` and a download of `Xenova/multilingual-e5-small` | npm registry, Hugging Face |
| Jev rule check | `ruleCheck` (default **off**) | the card's rules, the turn's final message (up to 12,000 chars) and the uncommitted diff (up to 80,000 chars), with secrets redacted | `api.typesafe.ai` |
| Jev span selection and labels | `jevEnabled` (default **off**) | text of user messages and spans considered for the seed | `api.typesafe.ai` |
| Jev note re-ranking | `jevEnabled` and `jevDenseRerank` | working-note candidates and the current work | `api.typesafe.ai` |
| Jev search ranking | `jevEnabled` | the search query and up to 20 redacted excerpts | `api.typesafe.ai` |
| Doctor key probe | `doctor --jev` / `S4_JEV=1`, or `doctor` while `ruleCheck` or `jevEnabled` is on in your settings and a key is set | one synthetic question; no session text | `api.typesafe.ai` |

Two settings turn every Jev path off:

- `jevDenyList` keeps all of them off in any project whose cwd contains one of the listed
  fragments, even when `jevEnabled` or `ruleCheck` is set. Both the working directory and the
  session root are checked, for the search ranking too.
- A project turned off with `setup.cjs disable` (`.exovault/s4-compact-off`) sends nothing to Jev,
  search ranking included.
- Leaving `TYPESAFE_API_KEY` unset also turns them all off, unless `EXO_JEV_URL` names a server on this machine.

`EXO_JEV_URL` (unset by default) sends every row that says `api.typesafe.ai` to the address it names instead: a Jev
server of your own. Nothing in those rows then goes to TypeSafe. `TYPESAFE_API_KEY`, when set, is sent to that address
as the bearer key; an address on this machine needs no key. See
[install.md](install.md#a-jev-server-of-your-own-exo_jev_url-experimental).

The local vectors run on the CPU. After the first install, search, embedding and indexing never
send anything over the network.

## What is written to disk

| Location | Contents | Lifetime |
|---|---|---|
| `<project>/.exovault/s4-compact-active` / `s4-compact-off` | optional capture-root pin and opt-out flags (a plain install needs neither; capture then lands in `~/.exovault/s4-capture/`) | until removed |
| `<project>/.exovault/.gitignore` | `*`, so git ignores the whole directory (written with the first capture and by `setup.cjs enable`/`optout`; one you wrote is kept) | until removed |
| `<project>/.exovault/s4-capture/<session id>/` | the capture store: excerpts of user messages, tool calls, Bash output lines, the task card and per-cut state files | `retentionDays` (30) after the session's last write, for the home capture store; kept under a project's own `.exovault` |
| `~/.claude/exovault/recall/<sha256(session id)>/` | the session index, embeddings, saved briefs with their checklists, and copies of rules files the user adopted | `retentionDays` (30) after the session's last write |
| `~/.claude/exovault/recall-runtime/` | transformers.js and the e5-small model, about 280 MB | kept, and pruned of unused binaries |

Before anything is written to the capture store, secret values are redacted and home-directory
paths are shortened. This covers API keys, tokens, URL credentials and PEM blocks. The search index and
the saved briefs are redacted the same way. The redaction is pattern-based, so treat these directories as
sensitive anyway.

Retention: the recall build worker deletes, at most once a day, the index and the home capture directory of
every session untouched for `retentionDays` days (default 30, Claude Code's own default for keeping
transcripts; `0` keeps everything). Captures under a project's own `.exovault` are left alone. A session counts as
touched by its newest file in either store, and every turn marks its index, so a resumed session keeps its index
even when the turn was too small to rebuild it.

`setup.cjs cleanup` does both by hand: it redacts again, with today's patterns, every stored index generation,
brief, checklist, session map and search log (data an older version wrote holds keys the current patterns
catch; record paths included, and nothing is shortened), and the text files of every capture directory it keeps
(segments, work log, task card, notices, adopted files), and applies the retention. Capture writes take no lock, so
a capture written in the last hour is skipped and a capture a session writes to during the run is left whole;
both are counted, and the next run redacts them. Run from a session, it leaves that session's own data alone.
Without `--apply` it is a dry run that prints the numbers and changes nothing. With `--apply` it first writes
everything it will change or delete to `~/.exovault/backup-<date>.tar.gz` (owner-only, and still holding the
original text: delete it once the result looks right). Restart running sessions afterwards, since a recall server keeps what it already loaded.

```bash
node ~/.exo-compact/plugin/compact/setup.cjs cleanup                       # dry run
node ~/.exo-compact/plugin/compact/setup.cjs cleanup --apply               # backup, then redact and prune
node ~/.exo-compact/plugin/compact/setup.cjs cleanup --days 0 --apply      # redact only, keep every session
node ~/.exo-compact/plugin/compact/setup.cjs cleanup --capture-root ~/work/my-project   # also a project's captures
```

## Cost

The cut itself costs nothing: it builds the seed from what was captured, without a model call.
The ongoing cost comes from three places:

- **Task card refresh.** A background fork of the session's model, about once per context
  stretch and once per new task. In the earlier 8-task benchmark (3.56.0) this came to about $1.6 per chain.
- **Brief checklist.** Only with `taskCard=false`: one `claude -p` call on Sonnet per long request,
  about $0.08–0.10 each. With the card on (the default) it is not written, since a card cut never
  shows it (since 4.1.0; before, it cost about $0.76 per chain). Set `briefDigestModel=""` to turn
  it off; the seed then shows the start of the brief instead of a checklist.
- **Stop-time checks** (brief check, rule check), both off by default. When one blocks a stop, the
  model runs one more short turn. The rule check itself is billed by TypeSafe.

In the A/B with the 4.8.0 defaults (nine chains per side at an equal window), the plugin arm cost
$4.21 per chain on the mean against $4.49 for native compaction, 6% less, but the per-chain ranges
overlap and the medians are close ($4.31 against $4.36), so the cost is on par. The plugin arm also
took about 24% less wall time, missed fewer hidden test gates and kept more session rules; see
[benchmarks.md](benchmarks.md). An earlier A/B with brief push and brief check on cost about 40%
more than native compaction; both are off by default since 4.8.0. The cost figures are the API-equivalent amounts Claude Code
reports. On a subscription plan, they count against your usage instead of being billed.

How to cut the cost, in order of effect:

1. `taskCard=false` saves the most. Without a card, the cut budget goes back to
   `totalBudgetTokens` (20,000).
2. With `taskCard=false`, `briefDigestModel=""` turns off the brief checklist as well.
3. Leave `briefCheck` and `briefPush` off (the default since 4.8.0). Turned on, they add turns
   and tokens to every chain.

The benchmark ran with the card on and both nudges off. It was not run with the card off, so the
quality effect of steps 1 and 2 is not known.
