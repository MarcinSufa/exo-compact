# How it works

exo-compact is a Claude Code function-hook plugin (`plugin/compact/compact.ts`). It works in
three steps:

1. While the session runs, it records state.
2. When the context fills, it replaces the `session.compact` event with a seed built from that state.
3. After the cut, a few small hooks and a search tool bring back what the model needs.

## 1. Capture

A plain plugin install is enough: with no flag file anywhere up the tree the plugin is active and its capture
root is the home directory. `.exovault/s4-compact-off` in the cwd or a parent turns it off (`setup.cjs disable <dir>`
writes it), and `.exovault/s4-compact-active` pins the capture root to that directory. It hooks prompts, tool calls and stops,
and writes compact records to `<project>/.exovault/s4-capture/<session>/`:

- **Constraints.** The user's standing instructions ("always…", "never…", limits), the newest
  value of anything the user changed, and rules files the user adopted ("read RULES.md and follow
  it"). Rules files are copied when the request is sent.
- **Task briefs.** A request of 2,500 characters or more is saved verbatim. Without a task card
  (`taskCard=false`), `claude -p` writes a checklist for it in the background (`briefDigestModel`).
- **Work state.** Files read and edited, commands, Bash output lines that matter, tasks,
  background jobs, and Git status at the cut.
- **Task card.** As the context fills, a background fork of the session's own model writes a short
  card: goal, rules, done, next, and open questions. It is refreshed once per stretch and once per
  new task.
- **Session index.** With `recallEnabled`, every answer updates a local index of the session for
  `search_session`. Local e5-small vectors are added when `recallVectors` is on.

## 2. The cut

On `session.compact` (automatic or `/compact`) the plugin builds the new context:

```
[[exovault:s4-seed:v1]]
Constraints · Task card · Task brief · Work state · Session map · Working notes · Transcript pointer · File pointers
<the most recent messages, verbatim>
```

- **Budget.** The seed and the kept tail share one token budget: `totalBudgetTokens`, or
  `cardTotalBudgetTokens` once a card exists, about what native compaction keeps.
- **Shrinking.** When the seed does not fit, sections shrink in a fixed order: working notes, then
  the brief, then the card's own tail lines, and last the user's rules files (3.57.0). If the seed
  still does not fit, the cut goes to native compaction.
- **Refusals.** If the model refuses after a seeded cut, the next cut goes to native compaction.
- **Subagents** always use native compaction.

A cut takes about 0.4 seconds at the median. Native compaction takes about 62 seconds at the median because it
calls the model.

## 3. After the cut

- **`search_session`** (MCP server `recall`) searches the pre-cut history. Parameters:
  - `query`;
  - `scope`: `session`, or `brief` for the saved brief's lines;
  - `segment`: one stretch between two cuts;
  - `around`: the context around an earlier hit;
  - `k`: at most 5 results.

  Matching is lexical, exact for hashes, numbers and quoted phrases, and by meaning when vectors
  are on.
- **Brief push** (`briefPush`). A write to a file is sent along with the brief lines about that
  file, each line once per cut.
- **Session push** (`sessionPush`). A user message that names a rare id or code is sent along with
  the compacted-away transcript lines that mention it.
- **Brief limits** (`briefLimits`). If a write adds lines longer than the brief's stated limit,
  the model gets a short note.
- **Brief check** (`briefCheck`). It blocks the first stop after a cut once and lists the brief's
  checks.
- **Rule check** (`ruleCheck`, opt-in, Jev). It blocks a stop once with the card rules that the
  reply or the diff breaks.

## Contract

`plugin/compact/CONTRACT.md` is the behavioural contract, one section per version; the gate tests
enforce it.
