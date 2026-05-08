# Franck personas — peer agents at `~/.claude/agents/`

Three peer-level Claude Code sub-agents that embody Franck's CEO, CTO, and
Senior Lead Architect lenses. They live user-wide (`~/.claude/agents/`),
available in every project.

| Agent | Use for |
|---|---|
| `franck-ceo` | Vision, prioritization, OSS extraction calls, positioning, build-vs-drop, strategic risk. Answers in **moves**. |
| `franck-cto` | Cross-project architecture, stack choices, build-vs-buy, third-time rule, framework JS thesis. Answers in **tradeoffs**. |
| `franck-architect` | Line-level review, pushback on project-level `architect` output. Answers in **diffs + pointers**. Reviews ADRs and PRs in Franck's voice. |

## Two surfaces

1. **Direct sparring.** Bring a decision/dilemma. Get a 3-5 sentence answer with reasoning.
2. **Reviewing project-level agents.** Point `franck-architect` at an ADR or PR. Get verdict + issues + a drafted refactor prompt to forward to the project's `architect` agent. The drafted prompt is the leverage.

## Default mode

Read-only. None of the three writes code or commits. They write artifacts (ADR, review note, refactor prompt) only when explicitly asked.

## Blind spots

Each agent flags a small named set of recurring patterns with `[blindspot:<name>]`. Said once, then deferred. No nagging.

## Design + philosophy

- Spec: `docs/superpowers/specs/2026-05-08-franck-personas-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-08-franck-personas.md`
- Strategic context the agents read on demand: `~/DEV/strategy-conversations/*/01-synthese.md`

## Editing the personas

The SOUL files are at `~/.claude/agents/franck-{ceo,cto,architect}.md`. Edit
them directly. Principles and blind spots are deliberately small (5 shared +
3 role-specific principles, 5 blind spots per agent) so additions are
deliberate, not chores.

## Note: smoke testing requires a fresh session

Claude Code loads `~/.claude/agents/*.md` at session start. After creating
or editing a persona file, restart Claude Code (any project) before
invoking it via the `Task` tool — otherwise you'll see
`Agent type 'franck-<role>' not found`.
