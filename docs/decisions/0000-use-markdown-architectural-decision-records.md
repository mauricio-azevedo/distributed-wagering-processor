---
status: accepted
date: 2026-10-27
---

# Use Markdown Architectural Decision Records

## Context and Problem Statement

`CONTRIBUTING.md` asks for an ADR, in the same PR, whenever a technical decision is costly or difficult to
change. Which format and structure should these records follow?

## Considered Options

- [MADR](https://adr.github.io/madr/) 4.0.0, the Markdown Architectural Decision Records
- [Michael Nygard's template](http://thinkrelevance.com/blog/2011/11/15/documenting-architecture-decisions),
  the first incarnation of the term "ADR"
- [Sustainable Architectural Decisions](https://www.infoq.com/articles/sustainable-architectural-design-decisions),
  the Y-Statements
- Other templates listed at <https://github.com/joelparkerhenderson/architecture_decision_record>
- Formless: no conventions for file format and structure

## Decision Outcome

Chosen option: "MADR 4.0.0", because

- One file per decision lives in the repository and is reviewed like code.
- Its `status` field records supersession, so a decision is replaced by a new file rather than edited;
  `CONTRIBUTING.md`, ADRs, builds on that.
- Its minimal template is short enough that every hard-to-reverse decision gets one.
- Its full template records the options and their pros and cons, so a decision also records what it
  rejected.

### Consequences

- Good, because a decision is one file, written and reviewed in the PR that makes it.
- Bad, because the explained templates are long for a small decision, so the bare ones will carry most of
  them.
- Worth revisiting if the ADRs need a field the format lacks, or enough of them exist to want a tool to
  browse them.
